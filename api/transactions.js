module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        error: 'POST만 허용됩니다.',
        message: 'POST만 허용됩니다.'
      });
    }

    const {
      lawdCode,
      area,
      currentFloor,
      totalFloors,
      aptName,
      address,
      buildingInfo
    } = req.body || {};

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
        normalizedAptName,
        address,
        buildingInfo
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
    const lowerPrice = adjustedPrices[0];
    const middlePrice = getMedian(adjustedPrices);

    const upperDecision = shouldUseUpperPrice({
      currentFloor,
      totalFloors,
      deals: adjustedDeals
    });

    let investigationPrice = lowerPrice;
    let appliedPriceType = '하위값';

    if (upperDecision.useUpper) {
      investigationPrice = upperPrice;
      appliedPriceType = '상위값';
    } else if (
      currentFloor &&
      totalFloors &&
      currentFloor >= totalFloors / 2
    ) {
      investigationPrice = middlePrice;
      appliedPriceType = '중위값';
    }

    const avgAdjustment = summarizeAdjustments(adjustedDeals);

    return res.status(200).json({
      source: '공공데이터포털 실거래가 API',
      lawdCode,
      transactionCount: filtered.length,
      usedTransactionCount: adjustedPrices.length,
      totalRawCount: allItems.length,
      fetchedMonthCount: fetchedMonths.size,

      upperPrice,
      middlePrice,
      lowerPrice,
      appliedPriceType,
      investigationPrice,

      upperPriceIncluded: upperDecision.useUpper,
      upperPriceReason: upperDecision.reason,

      adjustmentSummary: avgAdjustment,
      sampleDeals: adjustedDeals.slice(0, 5).map(d => ({
        name: d.name,
        area: d.area,
        floor: d.floor,
        buildYear: d.buildYear,
        dealYmd: d.dealYmd,
        originalPrice: d.price,
        adjustedPrice: d.adjustedPrice,
        adjustment: d.adjustment
      })),

      message: `✅ 거래 ${filtered.length}건 기반 감정평가 산정`
    });

  } catch (error) {
    return res.status(200).json({
      investigationPrice: null,
      transactionCount: 0,
      message: `❌ 서버 오류: ${error.message}`
    });
  }
};

function calculateDealAdjustment({
  item,
  currentFloor,
  totalFloors,
  normalizedAptName,
  address,
  buildingInfo
}) {
  const floorFactor = getFloorFactor(item.floor, currentFloor, totalFloors);
  const timeFactor = getTimeFactor(item.dealYmd, address);
  const complexFactor = getComplexFactor(item.name, normalizedAptName);

  const ageFactor = getAgeFactor({
    compBuildYear: item.buildYear,
    targetBuildYear: buildingInfo?.buildYear
  });

  const scaleFactor = getScaleFactor(buildingInfo?.householdCount);
  const parkingFactor = getParkingFactor(buildingInfo?.parkingPerHousehold);

  const totalFactor =
    floorFactor *
    timeFactor *
    complexFactor *
    ageFactor *
    scaleFactor *
    parkingFactor;

  return {
    floorFactor,
    timeFactor,
    complexFactor,
    ageFactor,
    scaleFactor,
    parkingFactor,
    totalFactor,

    floorPct: toPct(floorFactor),
    timePct: toPct(timeFactor),
    complexPct: toPct(complexFactor),
    agePct: toPct(ageFactor),
    scalePct: toPct(scaleFactor),
    parkingPct: toPct(parkingFactor),
    totalPct: toPct(totalFactor)
  };
}

function getFloorFactor(dealFloor, targetFloor, totalFloors) {
  if (!dealFloor || !targetFloor || !totalFloors) return 1;

  const targetRatio = targetFloor / totalFloors;

  let factor = 1;

  if (targetRatio <= 0.2) factor -= 0.05;
  else if (targetRatio <= 0.4) factor -= 0.02;
  else if (targetRatio >= 0.8) factor += 0.03;
  else if (targetRatio >= 0.6) factor += 0.01;

  const diff = targetFloor - dealFloor;
  factor += diff * 0.003;

  return clamp(factor, 0.9, 1.08);
}

function getTimeFactor(dealYmd, address = '') {
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
  else if (monthsAgo <= 12) factor = 0.98;
  else if (monthsAgo <= 18) factor = 0.96;
  else factor = 0.94;

  factor *= getRegionTrend(address);

  return clamp(factor, 0.88, 1.05);
}

function getRegionTrend(address = '') {
  const addr = String(address || '');

  if (addr.includes('서울')) return 1.02;

  if (
    ['성남', '수원', '용인', '고양', '화성', '과천', '광명', '하남']
      .some(v => addr.includes(v))
  ) {
    return 1.01;
  }

  if (
    ['부산', '대구', '광주', '대전', '울산', '인천']
      .some(v => addr.includes(v))
  ) {
    return 0.99;
  }

  return 0.97;
}

function getComplexFactor(itemName, normalizedAptName) {
  const item = normalizeAptName(itemName);

  if (!normalizedAptName || normalizedAptName === '확인필요' || !item) {
    return 0.97;
  }

  if (item === normalizedAptName) return 1.02;

  if (item.includes(normalizedAptName) || normalizedAptName.includes(item)) {
    return 1.00;
  }

  return 0.95;
}

function getAgeFactor({ compBuildYear, targetBuildYear }) {
  const now = new Date().getFullYear();

  if (!targetBuildYear) return 1;

  const targetAge = now - Number(targetBuildYear);

  if (compBuildYear) {
    const compAge = now - Number(compBuildYear);
    const diff = compAge - targetAge;

    let factor = 1 + diff * 0.003;
    return clamp(factor, 0.92, 1.06);
  }

  if (targetAge <= 5) return 1.04;
  if (targetAge <= 10) return 1.02;
  if (targetAge <= 20) return 1.00;
  if (targetAge <= 30) return 0.96;
  if (targetAge <= 40) return 0.92;
  return 0.88;
}

function getScaleFactor(householdCount) {
  const n = Number(householdCount || 0);

  if (!n) return 1;
  if (n >= 1000) return 1.02;
  if (n >= 500) return 1.01;
  if (n <= 100) return 0.98;

  return 1;
}

function getParkingFactor(parkingPerHousehold) {
  const p = Number(parkingPerHousehold || 0);

  if (!p) return 1;
  if (p >= 1.2) return 1.02;
  if (p >= 1.0) return 1.01;
  if (p <= 0.5) return 0.96;
  if (p <= 0.7) return 0.98;

  return 1;
}

function shouldUseUpperPrice({ currentFloor, totalFloors, deals }) {
  let score = 0;

  if (!deals || deals.length <= 3) score += 2;

  if (currentFloor && totalFloors && currentFloor >= totalFloors * 0.7) {
    score += 3;
  }

  const sameComplexDeals = deals.filter(v => v.adjustment.complexFactor >= 1).length;
  if (sameComplexDeals >= 3) score += 2;

  const recentDeals = deals.filter(v => v.adjustment.timeFactor >= 1).length;
  if (recentDeals >= 2) score += 1;

  return {
    useUpper: score >= 4,
    score,
    reason:
      score >= 4
        ? '고층·동일단지·최근거래 조건 충족으로 상위값 반영'
        : '보수적 평가를 위해 상위값 제외'
  };
}

function summarizeAdjustments(deals) {
  if (!deals.length) {
    return {
      floorPct: 0,
      timePct: 0,
      complexPct: 0,
      agePct: 0,
      scalePct: 0,
      parkingPct: 0,
      totalPct: 0
    };
  }

  const avg = key => {
    const value =
      deals.reduce((sum, d) => sum + Number(d.adjustment[key] || 0), 0) /
      deals.length;

    return Math.round(value * 10) / 10;
  };

  return {
    floorPct: avg('floorPct'),
    timePct: avg('timePct'),
    complexPct: avg('complexPct'),
    agePct: avg('agePct'),
    scalePct: avg('scalePct'),
    parkingPct: avg('parkingPct'),
    totalPct: avg('totalPct')
  };
}

function filterItems(allItems, normalizedAptName, targetArea) {
  let filtered = [...allItems];

  if (normalizedAptName && normalizedAptName !== '확인필요') {
    const sameApt = filtered.filter(item => {
      const itemName = normalizeAptName(item.name);

      return (
        itemName &&
        (
          itemName.includes(normalizedAptName) ||
          normalizedAptName.includes(itemName)
        )
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

        return items
          .map(item => {
            const name =
              getXml(item, '아파트') ||
              getXml(item, 'aptNm') ||
              '';

            const priceText =
              getXml(item, '거래금액') ||
              getXml(item, 'dealAmount');

            const areaText =
              getXml(item, '전용면적') ||
              getXml(item, 'excluUseAr');

            const floorText =
              getXml(item, '층') ||
              getXml(item, 'floor');

            const buildYearText =
              getXml(item, '건축년도') ||
              getXml(item, 'buildYear') ||
              '';

            const priceManwon =
              Number(String(priceText).replace(/[,\s]/g, ''));

            const exclusiveArea =
              Number(String(areaText).replace(/,/g, '').trim());

            const floor =
              Number(String(floorText).trim()) || 0;

            const buildYear =
              Number(String(buildYearText).trim()) || null;

            if (priceManwon && exclusiveArea) {
              return {
                name,
                price: priceManwon * 10000,
                area: exclusiveArea,
                floor,
                buildYear,
                dealYmd
              };
            }

            return null;
          })
          .filter(Boolean);
      })
      .catch(error => {
        console.log(`[transactions] ${dealYmd} 조회 실패:`, error.message);
        return [];
      });
  });

  const results = await Promise.all(promises);
  return results.flat();
}

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

function getMedian(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[mid];

  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function toPct(factor) {
  return Math.round((factor - 1) * 1000) / 10;
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
