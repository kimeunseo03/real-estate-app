module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST만 허용됩니다.', message: 'POST만 허용됩니다.' });
    }

    const { lawdCode, area, currentFloor, totalFloors, aptName } = req.body || {};
    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    if (!serviceKey) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
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

    const monthStages = [
      getRecentMonths(6),
      getRecentMonths(12),
      getRecentMonths(24)
    ];

    let allItems = [];
    let fetchedMonths = new Set();

    for (const months of monthStages) {
      const newMonths = months.filter(m => !fetchedMonths.has(m));
      if (!newMonths.length) continue;

      const newItems = await fetchMonths(newMonths, lawdCode, serviceKey);
      allItems = [...allItems, ...newItems];
      newMonths.forEach(m => fetchedMonths.add(m));

      if (!allItems.length) continue;

      const filtered = filterItems(allItems, normalizedAptName, targetArea);
      if (filtered.length >= MIN_DEALS) break;
    }

    if (!allItems.length) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
        lawdCode,
        totalRawCount: 0,
        message: `❌ ${lawdCode} 지역 최근 24개월 실거래 데이터 없음`
      });
    }

    const filtered = filterItems(allItems, normalizedAptName, targetArea);

    if (!filtered.length) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
        totalRawCount: allItems.length,
        lawdCode,
        message: `❌ 유사 거래 없음. 전체 거래 ${allItems.length}건`
      });
    }

    const adjustedDeals = filtered.map(item => {
      const adjustment = calculateDealAdjustment({
        item,
        currentFloor,
        totalFloors,
        normalizedAptName
      });

      return {
        ...item,
        adjustedPrice: Math.round(item.price * adjustment.totalFactor),
        adjustment
      };
    });

    const adjustedPrices = adjustedDeals
      .map(item => item.adjustedPrice)
      .sort((a, b) => a - b);

    const upperPrice = adjustedPrices[adjustedPrices.length - 1];

const upperDecision = shouldIncludeUpperPrice({
  deals: adjustedDeals,
  currentFloor,
  totalFloors
});

const pricesForSelection = upperDecision.includeUpper
  ? adjustedPrices
  : adjustedPrices.length >= 3
    ? adjustedPrices.slice(0, -1)
    : adjustedPrices;

const lowerPrice = pricesForSelection[0];
const middlePrice = getMedian(pricesForSelection);

const medianFloor = totalFloors ? totalFloors / 2 : 0;

let appliedPriceType = '하위값';
let investigationPrice = lowerPrice;

if (currentFloor && medianFloor) {
  if (currentFloor >= totalFloors * 0.7 && upperDecision.includeUpper) {
    appliedPriceType = '상위값';
    investigationPrice = upperPrice;
  } else if (currentFloor >= medianFloor) {
    appliedPriceType = '중위값';
    investigationPrice = middlePrice;
  }
}

const avgAdjustment = summarizeAdjustments(adjustedDeals);
    
return res.status(200).json({
  source: '공공데이터포털 실거래가 API',
  lawdCode,
  transactionCount: filtered.length,
  usedTransactionCount: pricesForSelection.length,
  totalRawCount: allItems.length,
  fetchedMonthCount: fetchedMonths.size,

  upperPrice,
  middlePrice,
  lowerPrice,
  appliedPriceType,
  investigationPrice,

  upperPriceIncluded: upperDecision.includeUpper,
  upperPriceReason: upperDecision.reason,

  adjustmentSummary: avgAdjustment,
  sampleDeals: adjustedDeals.slice(0, 5).map(d => ({
    name: d.name,
    area: d.area,
    floor: d.floor,
    dealYmd: d.dealYmd,
    originalPrice: d.price,
    adjustedPrice: d.adjustedPrice,
    adjustment: d.adjustment
  })),

  message: `✅ 성공: 유사 거래 ${filtered.length}건, 보정 적용 후 산정`
});

  } catch (error) {
    return res.status(200).json({
      investigationPrice: null,
      transactionCount: 0,
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
      'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade' +
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

        return items.map(item => {
          const name = getXml(item, '아파트') || getXml(item, 'aptNm') || '';
          const priceText = getXml(item, '거래금액') || getXml(item, 'dealAmount');
          const areaText = getXml(item, '전용면적') || getXml(item, 'excluUseAr');
          const floorText = getXml(item, '층') || getXml(item, 'floor');

          const priceManwon = Number(String(priceText).replace(/[,\s]/g, ''));
          const exclusiveArea = Number(String(areaText).replace(/,/g, '').trim());
          const floor = Number(String(floorText).trim()) || 0;

          if (priceManwon && exclusiveArea) {
            return {
              name,
              price: priceManwon * 10000,
              area: exclusiveArea,
              floor,
              dealYmd
            };
          }

          return null;
        }).filter(Boolean);
      })
      .catch(error => {
        console.log(`[transactions] ${dealYmd} 조회 실패:`, error.message);
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

function calculateDealAdjustment({ item, currentFloor, totalFloors, normalizedAptName }) {
  const floorFactor = getFloorFactor(item.floor, currentFloor, totalFloors);
  const timeFactor = getTimeFactor(item.dealYmd);
  const complexFactor = getComplexFactor(item.name, normalizedAptName);

  const totalFactor = floorFactor * timeFactor * complexFactor;

  return {
    floorFactor,
    timeFactor,
    complexFactor,
    totalFactor,
    floorPct: Math.round((floorFactor - 1) * 1000) / 10,
    timePct: Math.round((timeFactor - 1) * 1000) / 10,
    complexPct: Math.round((complexFactor - 1) * 1000) / 10,
    totalPct: Math.round((totalFactor - 1) * 1000) / 10
  };
}

function getFloorFactor(dealFloor, targetFloor, totalFloors) {
  if (!dealFloor || !targetFloor || !totalFloors) return 1;

  const diff = targetFloor - dealFloor;
  let factor = 1 + diff * 0.005;

  if (targetFloor <= 2) factor -= 0.015;
  if (totalFloors >= 10 && targetFloor >= totalFloors * 0.7) factor += 0.01;

  return clamp(factor, 0.95, 1.05);
}

function getTimeFactor(dealYmd) {
  if (!dealYmd || String(dealYmd).length < 6) return 1;

  const yyyy = Number(String(dealYmd).slice(0, 4));
  const mm = Number(String(dealYmd).slice(4, 6));
  const dealDate = new Date(yyyy, mm - 1, 1);
  const now = new Date();

  const monthsAgo =
    (now.getFullYear() - dealDate.getFullYear()) * 12 +
    (now.getMonth() - dealDate.getMonth());

  let factor = 1;

  if (monthsAgo <= 3) factor = 1.01;
  else if (monthsAgo <= 6) factor = 1.00;
  else if (monthsAgo <= 12) factor = 0.985;
  else if (monthsAgo <= 18) factor = 0.97;
  else factor = 0.95;

  return factor;
}

function getComplexFactor(itemName, normalizedAptName) {
  const item = normalizeAptName(itemName);

  if (!normalizedAptName || normalizedAptName === '확인필요' || !item) return 0.98;
  if (item === normalizedAptName) return 1.01;
  if (item.includes(normalizedAptName) || normalizedAptName.includes(item)) return 1.00;

  return 0.97;
}

function summarizeAdjustments(deals) {
  if (!deals.length) {
    return {
      floorPct: 0,
      timePct: 0,
      complexPct: 0,
      totalPct: 0
    };
  }

  const avg = key => {
    const v = deals.reduce((s, d) => s + Number(d.adjustment[key] || 0), 0) / deals.length;
    return Math.round(v * 10) / 10;
  };

  return {
    floorPct: avg('floorPct'),
    timePct: avg('timePct'),
    complexPct: avg('complexPct'),
    totalPct: avg('totalPct')
  };
}

function getMedian(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[mid];

  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function shouldIncludeUpperPrice({ deals, currentFloor, totalFloors }) {
  if (!deals || deals.length <= 3) {
    return {
      includeUpper: true,
      reason: '거래사례가 3건 이하로 상위값 제외 시 왜곡 가능'
    };
  }

  const medianFloor = totalFloors ? totalFloors / 2 : 0;

  if (currentFloor && totalFloors && currentFloor >= totalFloors * 0.7) {
    return {
      includeUpper: true,
      reason: '대상 물건이 고층 또는 로열층 구간으로 상위값 반영 가능'
    };
  }

  if (currentFloor && medianFloor && currentFloor >= medianFloor) {
    return {
      includeUpper: false,
      reason: '중위층 이상이나 극단값 방지를 위해 상위값은 참고만 하고 중위값 적용'
    };
  }

  return {
    includeUpper: false,
    reason: '저층 또는 중하층 물건으로 보수적 평가를 위해 상위값 제외'
  };
}
