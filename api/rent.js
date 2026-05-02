// api/rent.js
// 전월세 실거래가 API 기반 수익환원법 계산
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ message: 'POST만 허용됩니다.' });
    }

    const { address, aptName, area } = req.body || {};
    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    if (!serviceKey) {
      return res.status(200).json({
        incomeApproach: null, rentCount: 0,
        message: '❌ API KEY 없음: Vercel 환경변수 PUBLIC_DATA_API_KEY를 확인하세요.'
      });
    }

    const lawdCode = await getLawdCode(address, serviceKey);
    if (!lawdCode) {
      return res.status(200).json({
        incomeApproach: null, rentCount: 0,
        message: `❌ 법정동코드 매칭 실패: ${address}`
      });
    }

    const months = getRecentMonths(12); // 전월세는 12개월 기준

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
        `&numOfRows=100`;
      return fetchWithTimeout(url, 8000)
        .then(xml => {
          const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
          return items.map(item => {
            const name = getXml(item, '아파트') || getXml(item, 'aptNm') || '';
            const depositText = getXml(item, '보증금액') || getXml(item, 'deposit') || '0';
            const monthlyText = getXml(item, '월세금액') || getXml(item, 'monthlyRent') || '0';
            const areaText = getXml(item, '전용면적') || getXml(item, 'excluUseAr') || '0';
            const typeText = getXml(item, '전월세구분') || '';
            const deposit = Number(String(depositText).replace(/[,\s]/g, '')) * 10000;
            const monthlyRent = Number(String(monthlyText).replace(/[,\s]/g, '')) * 10000;
            const exclusiveArea = Number(String(areaText).replace(/,/g, '').trim());
            if (exclusiveArea > 0) {
              return { name, deposit, monthlyRent, area: exclusiveArea, type: typeText };
            }
            return null;
          }).filter(Boolean);
        })
        .catch(() => []);
    });

    const results = await Promise.all(promises);
    const allRentItems = results.flat();

    if (!allRentItems.length) {
      return res.status(200).json({
        incomeApproach: null, rentCount: 0,
        lawdCode,
        message: `❌ ${lawdCode} 지역 최근 12개월 전월세 데이터 없음`
      });
    }

    const targetArea = Number(area || 0);
    const normalizedAptName = normalizeAptName(aptName);
    let filtered = [...allRentItems];

    // 단지명 필터
    if (normalizedAptName && normalizedAptName !== '확인필요') {
      const sameApt = filtered.filter(item => {
        const itemName = normalizeAptName(item.name);
        return itemName && (itemName.includes(normalizedAptName) || normalizedAptName.includes(itemName));
      });
      if (sameApt.length) filtered = sameApt;
    }

    // 면적 필터 (±10㎡)
    if (targetArea) {
      const areaFiltered = filtered.filter(item => Math.abs(item.area - targetArea) <= 10);
      if (areaFiltered.length) filtered = areaFiltered;
    }

    if (!filtered.length) {
      return res.status(200).json({
        incomeApproach: null, rentCount: 0,
        totalRawCount: allRentItems.length, lawdCode,
        message: `❌ 유사 전월세 거래 없음. 전체 ${allRentItems.length}건`
      });
    }

    // 전세 → 월세 환산 (전환율 4%)
    const CONVERT_RATE = 0.04;
    const CAP_RATE = 0.045;

    const monthlyRentEquivalents = filtered.map(d => {
      if (d.type === '전세' || d.monthlyRent === 0) {
        // 전세: 보증금 × 전환율 / 12
        return (d.deposit * CONVERT_RATE) / 12;
      } else {
        // 월세: 보증금 전환분 + 월세
        return (d.deposit * CONVERT_RATE) / 12 + d.monthlyRent;
      }
    }).filter(v => v > 0).sort((a, b) => a - b);

    if (!monthlyRentEquivalents.length) {
      return res.status(200).json({
        incomeApproach: null, rentCount: filtered.length,
        lawdCode, message: '❌ 유효한 임대료 데이터 없음'
      });
    }

    const medianMonthlyRent = monthlyRentEquivalents[Math.floor(monthlyRentEquivalents.length / 2)];
    const annualGrossIncome = medianMonthlyRent * 12;
    const annualNetIncome = Math.round(annualGrossIncome * 0.82); // 공실·관리비 18% 차감
    const incomeApproach = Math.round(annualNetIncome / CAP_RATE);

    return res.status(200).json({
      source: '공공데이터포털 전월세 실거래가 API',
      lawdCode,
      rentCount: filtered.length,
      totalRawCount: allRentItems.length,
      medianMonthlyRent: Math.round(medianMonthlyRent),
      annualGrossIncome: Math.round(annualGrossIncome),
      annualNetIncome,
      convertRate: CONVERT_RATE,
      capRate: CAP_RATE,
      incomeApproach,
      rawDeals: filtered.slice(0, 5).map(d => ({
        area: d.area, deposit: d.deposit, monthlyRent: d.monthlyRent, type: d.type
      })),
      message: `✅ 성공: 유사 전월세 ${filtered.length}건 기준 산정`
    });

  } catch (error) {
    return res.status(200).json({
      incomeApproach: null, rentCount: 0,
      message: `❌ 서버 오류: ${error.message}`
    });
  }
};

function getXml(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : '';
}

function getRecentMonths(count) {
  const result = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    result.push(`${yyyy}${mm}`);
  }
  return result;
}

function normalizeAptName(name = '') {
  return String(name || '')
    .replace(/\s/g, '')
    .replace(/아파트|APT|apt|단지|제\d+동|제\d+호/g, '')
    .trim();
}

async function getLawdCode(address = '', serviceKey = '') {
  const text = String(address || '').replace(/\s+/g, ' ').trim();
  const parts = text.split(' ');
  const sido = parts[0] || '';
  const sigungu = parts[1] || '';
  if (!sido || !sigungu) return null;

  const keyword = `${sido} ${sigungu}`;

  const url =
    'https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList' +
    `?serviceKey=${serviceKey}` +
    '&type=json' +
    '&pageNo=1' +
    '&numOfRows=1000' +
    `&locatadd_nm=${encodeURIComponent(keyword)}`;

  let rows = [];
  try {
    const response = await fetch(url);
    const data = await response.json();
    rows =
      data?.StanReginCd?.[1]?.row ||
      data?.response?.body?.items?.item ||
      data?.items?.item ||
      [];
    if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  } catch (e) {
    return null;
  }

  const exact = rows.find(row => {
    const name = row.locatadd_nm || row.locallow_nm || '';
    const code = String(row.region_cd || row.regionCd || '');
    return name.includes(keyword) && code.length >= 5 && code.endsWith('00000');
  });
  if (exact) return String(exact.region_cd || exact.regionCd).slice(0, 5);

  const fallback = rows.find(row => {
    const name = row.locatadd_nm || row.locallow_nm || '';
    const code = String(row.region_cd || row.regionCd || '');
    return name.includes(sigungu) && code.length >= 5 && code.endsWith('00000');
  });
  if (fallback) return String(fallback.region_cd || fallback.regionCd).slice(0, 5);

  const loose = rows.find(row => {
    const name = row.locatadd_nm || row.locallow_nm || '';
    return name.includes(sigungu);
  });
  return loose ? String(loose.region_cd || loose.regionCd).slice(0, 5) : null;
}
