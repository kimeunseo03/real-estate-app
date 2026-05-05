module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ message: 'POST만 허용됩니다.' });
    }

    const { lawdCode, area, aptName } = req.body || {};
    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    if (!serviceKey) {
      return res.status(200).json({
        incomeApproach: null,
        rentCount: 0,
        message: '❌ API KEY 없음'
      });
    }

    if (!lawdCode) {
      return res.status(200).json({
        incomeApproach: null,
        rentCount: 0,
        message: '❌ lawdCode 없음'
      });
    }

    const targetArea = Number(area || 0);
    const normalizedAptName = normalizeAptName(aptName);
    const MIN_DEALS = 3;

    const monthStages = [
      getRecentMonths(3),
      getRecentMonths(6),
      getRecentMonths(12)
    ];

    let allRentItems = [];
    let fetchedMonths = new Set();

    for (const months of monthStages) {
      const newMonths = months.filter(m => !fetchedMonths.has(m));
      if (newMonths.length === 0) continue;

      const newItems = await fetchMonths(newMonths, lawdCode, serviceKey);
      allRentItems = [...allRentItems, ...newItems];
      newMonths.forEach(m => fetchedMonths.add(m));

      if (!allRentItems.length) continue;

      const filtered = filterItems(allRentItems, normalizedAptName, targetArea);
      if (filtered.length >= MIN_DEALS) break;
    }

    if (!allRentItems.length) {
      return res.status(200).json({
        incomeApproach: null,
        rentCount: 0,
        totalRawCount: 0,
        lawdCode,
        message: `❌ ${lawdCode} 지역 최근 12개월 전월세 데이터 없음`
      });
    }

    const filtered = filterItems(allRentItems, normalizedAptName, targetArea);

    if (!filtered.length) {
      return res.status(200).json({
        incomeApproach: null,
        rentCount: 0,
        totalRawCount: allRentItems.length,
        lawdCode,
        message: `❌ 유사 전월세 거래 없음. 전체 전월세 ${allRentItems.length}건`
      });
    }

    const CONVERT_RATE = 0.04;
    const CAP_RATE = 0.045;

    const monthlyRentEquivalents = filtered
      .map(d => {
        if (d.type === '전세' || d.monthlyRent === 0) {
          return (d.deposit * CONVERT_RATE) / 12;
        }

        return (d.deposit * CONVERT_RATE) / 12 + d.monthlyRent;
      })
      .filter(v => v > 0)
      .sort((a, b) => a - b);

    if (!monthlyRentEquivalents.length) {
      return res.status(200).json({
        incomeApproach: null,
        rentCount: filtered.length,
        totalRawCount: allRentItems.length,
        lawdCode,
        message: '❌ 유효한 임대료 데이터 없음'
      });
    }

    const medianMonthlyRent = getMedian(monthlyRentEquivalents);
    const annualGrossIncome = medianMonthlyRent * 12;
    const annualNetIncome = Math.round(annualGrossIncome * 0.82);
    const incomeApproach = Math.round(annualNetIncome / CAP_RATE);

    return res.status(200).json({
      source: '공공데이터포털 전월세 실거래가 API',
      lawdCode,
      rentCount: filtered.length,
      totalRawCount: allRentItems.length,
      fetchedMonthCount: fetchedMonths.size,
      medianMonthlyRent: Math.round(medianMonthlyRent),
      annualGrossIncome: Math.round(annualGrossIncome),
      annualNetIncome,
      convertRate: CONVERT_RATE,
      capRate: CAP_RATE,
      incomeApproach,
      message: `✅ 성공: 최근 ${fetchedMonths.size}개월 조회, 유사 전월세 ${filtered.length}건 기준 산정`
    });

  } catch (error) {
    return res.status(200).json({
      incomeApproach: null,
      rentCount: 0,
      message: `❌ 서버 오류: ${error.message}`
    });
  }
};

function getRecentMonths(totalMonths) {
  const result = [];
  const now = new Date();

  for (let i = 0; i < totalMonths; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    result.push(`${yyyy}${mm}`);
  }

  return result;
}

async function fetchMonths(months, lawdCode, serviceKey) {
  async function fetchWithTimeout(url, ms = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    try {
      const r = await fetch(url, { signal: controller.signal });
      return await r.text();
    } finally {
      clearTimeout(timer);
    }
  }

  const promises = months.map(dealYmd => {
    const url =
      'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent' +
      `?serviceKey=${serviceKey}` +
      `&LAWD_CD=${lawdCode}` +
      `&DEAL_YMD=${dealYmd}` +
      `&numOfRows=1000`;

    return fetchWithTimeout(url, 8000)
      .then(xml => {
        if (
          xml.includes('SERVICE KEY IS NOT REGISTERED ERROR') ||
          xml.includes('SERVICE_KEY_IS_NOT_REGISTERED_ERROR')
        ) {
          throw new Error('SERVICE KEY IS NOT REGISTERED ERROR');
        }

        const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

        return items
          .map(item => {
            const name =
              getXml(item, '아파트') ||
              getXml(item, 'aptNm') ||
              '';

            const depositText =
              getXml(item, '보증금액') ||
              getXml(item, 'deposit') ||
              '0';

            const monthlyText =
              getXml(item, '월세금액') ||
              getXml(item, 'monthlyRent') ||
              '0';

            const areaText =
              getXml(item, '전용면적') ||
              getXml(item, 'excluUseAr') ||
              '0';

            const typeText =
              getXml(item, '전월세구분') ||
              getXml(item, 'rentSe') ||
              '';

            const floorText =
              getXml(item, '층') ||
              getXml(item, 'floor') ||
              '0';

            const deposit = Number(String(depositText).replace(/[,\s]/g, '')) * 10000;
            const monthlyRent = Number(String(monthlyText).replace(/[,\s]/g, '')) * 10000;
            const exclusiveArea = Number(String(areaText).replace(/,/g, '').trim());
            const floor = Number(String(floorText).trim()) || 0;

            if (exclusiveArea > 0) {
              return {
                name,
                deposit,
                monthlyRent,
                area: exclusiveArea,
                floor,
                type: typeText,
                dealYmd
              };
            }

            return null;
          })
          .filter(Boolean);
      })
      .catch(error => {
        console.log(`[rent] ${dealYmd} 조회 실패:`, error.message);
        return [];
      });
  });

  const results = await Promise.all(promises);
  return results.flat();
}

function filterItems(allItems, normalizedAptName, targetArea) {
  let filtered = [...allItems];

  if (normalizedAptName && normalizedAptName !== '확인필요') {
    const sameApt = filtered.filter(item => {
      const itemName = normalizeAptName(item.name);
      return itemName && (
        itemName.includes(normalizedAptName) ||
        normalizedAptName.includes(itemName)
      );
    });

    if (sameApt.length) filtered = sameApt;
  }

  if (targetArea) {
    const areaFiltered = filtered.filter(item => {
      return Math.abs(item.area - targetArea) <= 10;
    });

    if (areaFiltered.length) filtered = areaFiltered;
  }

  return filtered;
}

function getMedian(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }

  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function getXml(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : '';
}

function normalizeAptName(name = '') {
  return String(name || '')
    .replace(/\s/g, '')
    .replace(/아파트|APT|apt|단지|제\d+동|제\d+호/g, '')
    .trim();
}
