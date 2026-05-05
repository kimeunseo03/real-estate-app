module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST만 허용됩니다.', message: 'POST만 허용됩니다.' });
    }

    const { lawdCode, area, currentFloor, totalFloors, aptName } = req.body || {};
    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    if (!serviceKey) {
      return res.status(200).json({
        investigationPrice: null, transactionCount: 0,
        message: '❌ API KEY 없음'
      });
    }

    if (!lawdCode) {
  return res.status(200).json({
    investigationPrice: null,
    transactionCount: 0,
    message: '❌ lawdCode 없음'
  });
}

    const targetArea = Number(area || 0);
    const normalizedAptName = normalizeAptName(aptName);
    const MIN_DEALS = 5;

    // 분기별 조회: 최근 6개월(2분기) → 12개월(4분기) → 24개월(8분기)
    // 월별 24번 대신 분기 시작월만 요청 → 최대 8번
    const quarterStages = [
      getQuarterMonths(6),   // 2분기 = 2번
      getQuarterMonths(12),  // 4분기 = 4번 (앞 2번 제외하고 2번 추가)
      getQuarterMonths(24),  // 8분기 = 8번 (앞 4번 제외하고 4번 추가)
    ];

    let allItems = [];
    let usedStage = 0;
    let fetchedQuarters = new Set();

    for (const quarters of quarterStages) {
      // 이미 조회한 분기 제외하고 새 분기만 추가 조회
      const newQuarters = quarters.filter(q => !fetchedQuarters.has(q));
      if (newQuarters.length === 0) continue;

      const newItems = await fetchQuarters(newQuarters, lawdCode, serviceKey);
      allItems = [...allItems, ...newItems];
      newQuarters.forEach(q => fetchedQuarters.add(q));
      usedStage++;

      if (!allItems.length) continue;

      const filtered = filterItems(allItems, normalizedAptName, targetArea);
      if (filtered.length >= MIN_DEALS) break;
    }

    if (!allItems.length) {
      return res.status(200).json({
        investigationPrice: null, transactionCount: 0,
        lawdCode, totalRawCount: 0,
        message: `❌ ${lawdCode} 지역 최근 24개월 실거래 데이터 없음`
      });
    }

    let filtered = filterItems(allItems, normalizedAptName, targetArea);

    if (!filtered.length) {
      return res.status(200).json({
        investigationPrice: null, transactionCount: 0,
        totalRawCount: allItems.length, lawdCode,
        message: `❌ 유사 거래 없음. 전체 거래 ${allItems.length}건`
      });
    }

    const prices = filtered.map(item => item.price).sort((a, b) => a - b);
    const upperPrice = prices[prices.length - 1];
    const pricesWithoutUpper = prices.length >= 3 ? prices.slice(0, -1) : prices;
    const lowerPrice = pricesWithoutUpper[0];
    const middlePrice = pricesWithoutUpper[Math.floor(pricesWithoutUpper.length / 2)];
    const medianFloor = totalFloors ? totalFloors / 2 : 0;
    const useLower = currentFloor && medianFloor ? currentFloor < medianFloor : true;

    return res.status(200).json({
      source: '공공데이터포털 실거래가 API',
      lawdCode,
      transactionCount: filtered.length,
      usedTransactionCount: pricesWithoutUpper.length,
      totalRawCount: allItems.length,
      upperPrice, middlePrice, lowerPrice,
      appliedPriceType: useLower ? '하위값' : '중위값',
      investigationPrice: useLower ? lowerPrice : middlePrice,
      message: `✅ 성공: 유사 거래 ${filtered.length}건 기준 산정`
    });

  } catch (error) {
    return res.status(200).json({
      investigationPrice: null, transactionCount: 0,
      message: `❌ 서버 오류: ${error.message}`
    });
  }
};

// 분기 시작월 목록 반환 (3개월 간격)
function getQuarterMonths(totalMonths) {
  const result = [];
  const now = new Date();
  for (let i = 0; i < totalMonths; i += 3) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    result.push(`${yyyy}${mm}`);
  }
  return result;
}

async function fetchQuarters(quarters, lawdCode, serviceKey) {
  async function fetchWithTimeout(url, ms = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const r = await fetch(url, { signal: controller.signal });
      return await r.text();
    } finally {
      clearTimeout(timer);
    }
  }

  const promises = quarters.map(dealYmd => {
    const url =
      'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade' +
      `?serviceKey=${serviceKey}` +
      `&LAWD_CD=${lawdCode}` +
      `&DEAL_YMD=${dealYmd}` +
      `&numOfRows=100`;
    return fetchWithTimeout(url, 5000)
      .then(xml => {
        const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        return items.map(item => {
          const name = getXml(item, '아파트') || getXml(item, 'aptNm') || '';
          const priceText = getXml(item, '거래금액') || getXml(item, 'dealAmount');
          const areaText = getXml(item, '전용면적') || getXml(item, 'excluUseAr');
          const floorText = getXml(item, '층') || getXml(item, 'floor');
          const priceManwon = Number(String(priceText).replace(/[,\s]/g, ''));
          const exclusiveArea = Number(String(areaText).replace(/,/g, '').trim());
          const floor = Number(String(floorText).trim());
          if (priceManwon && exclusiveArea) {
            return { name, price: priceManwon * 10000, area: exclusiveArea, floor };
          }
          return null;
        }).filter(Boolean);
      })
      .catch(() => []);
  });

  const results = await Promise.all(promises);
  return results.flat();
}

function filterItems(allItems, normalizedAptName, targetArea) {
  let filtered = [...allItems];
  if (normalizedAptName && normalizedAptName !== '확인필요') {
    const sameApt = filtered.filter(item => {
      const itemName = normalizeAptName(item.name);
      return itemName && (itemName.includes(normalizedAptName) || normalizedAptName.includes(itemName));
    });
    if (sameApt.length) filtered = sameApt;
  }
  if (targetArea) {
    const areaFiltered = filtered.filter(item => Math.abs(item.area - targetArea) <= 10);
    if (areaFiltered.length) filtered = areaFiltered;
  }
  return filtered;
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
