module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        error: 'POST만 허용됩니다.'
      });
    }

    const {
      lawdCode,
      area,
      currentFloor,
      totalFloors,
      aptName
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

    const monthStages = [
      getRecentMonths(6),
      getRecentMonths(12),
      getRecentMonths(24)
    ];

    let allItems = [];
    let fetchedMonths = new Set();

    for (const months of monthStages) {
      const newMonths = months.filter(m => !fetchedMonths.has(m));

      const newItems = await fetchMonths(
        newMonths,
        lawdCode,
        serviceKey
      );

      allItems = [...allItems, ...newItems];

      newMonths.forEach(m => fetchedMonths.add(m));

      const filtered = filterItems(
        allItems,
        normalizedAptName,
        targetArea
      );

      if (filtered.length >= 5) break;
    }

    if (!allItems.length) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
        message: '❌ 실거래 데이터 없음'
      });
    }

    const filtered = filterItems(
      allItems,
      normalizedAptName,
      targetArea
    );

    if (!filtered.length) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
        totalRawCount: allItems.length,
        message: '❌ 유사 거래 없음'
      });
    }

    const adjustedDeals = filtered.map(item => {
      const adjustment = calculateDealAdjustment({
        item,
        currentFloor,
        totalFloors,
        normalizedAptName,
        totalDeals: filtered.length
      });

      return {
        ...item,
        adjustedPrice: Math.round(
          item.price * adjustment.totalFactor
        ),
        adjustment
      };
    });

    const adjustedPrices = adjustedDeals
      .map(v => v.adjustedPrice)
      .sort((a, b) => a - b);

    const upperPrice =
      adjustedPrices[adjustedPrices.length - 1];

    const lowerPrice =
      adjustedPrices[0];

    const middlePrice =
      getMedian(adjustedPrices);

    const upperDecision =
      shouldUseUpperPrice({
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

    const avgAdjustment =
      summarizeAdjustments(adjustedDeals);

    return res.status(200).json({
      source: '공공데이터포털 실거래가 API',

      lawdCode,

      transactionCount: filtered.length,
      totalRawCount: allItems.length,

      fetchedMonthCount: fetchedMonths.size,

      upperPrice,
      middlePrice,
      lowerPrice,

      appliedPriceType,

      upperPriceIncluded:
        upperDecision.useUpper,

      upperPriceReason:
        upperDecision.reason,

      investigationPrice,

      adjustmentSummary: avgAdjustment,

      sampleDeals:
        adjustedDeals.slice(0, 5),

      message:
        `✅ 거래 ${filtered.length}건 기반 감정평가 산정`
    });

  } catch (error) {
    return res.status(200).json({
      investigationPrice: null,
      transactionCount: 0,
      message: `❌ 서버 오류: ${error.message}`
    });
  }
};

function shouldUseUpperPrice({
  currentFloor,
  totalFloors,
  deals
}) {

  let score = 0;

  if (deals.length <= 3) score += 2;

  if (
    currentFloor &&
    totalFloors &&
    currentFloor >= totalFloors * 0.7
  ) {
    score += 3;
  }

  const sameComplexDeals =
    deals.filter(v =>
      v.adjustment.complexFactor >= 1
    ).length;

  if (sameComplexDeals >= 3) score += 2;

  const recentDeals =
    deals.filter(v =>
      v.adjustment.timeFactor >= 1
    ).length;

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

function calculateDealAdjustment({
  item,
  currentFloor,
  totalFloors,
  normalizedAptName
}) {

  const floorFactor =
    getFloorFactor(
      item.floor,
      currentFloor,
      totalFloors
    );

  const timeFactor =
    getTimeFactor(item.dealYmd);

  const complexFactor =
    getComplexFactor(
      item.name,
      normalizedAptName
    );

  const totalFactor =
    floorFactor *
    timeFactor *
    complexFactor;

  return {
    floorFactor,
    timeFactor,
    complexFactor,
    totalFactor,

    floorPct:
      Math.round((floorFactor - 1) * 1000) / 10,

    timePct:
      Math.round((timeFactor - 1) * 1000) / 10,

    complexPct:
      Math.round((complexFactor - 1) * 1000) / 10,

    totalPct:
      Math.round((totalFactor - 1) * 1000) / 10
  };
}

function getFloorFactor(
  dealFloor,
  targetFloor,
  totalFloors
) {

  if (
    !dealFloor ||
    !targetFloor ||
    !totalFloors
  ) return 1;

  const targetRatio =
    targetFloor / totalFloors;

  let factor = 1;

  if (targetRatio <= 0.2) {
    factor -= 0.05;
  }
  else if (targetRatio <= 0.4) {
    factor -= 0.02;
  }
  else if (targetRatio >= 0.8) {
    factor += 0.03;
  }
  else if (targetRatio >= 0.6) {
    factor += 0.01;
  }

  const diff =
    targetFloor - dealFloor;

  factor += diff * 0.003;

  return clamp(factor, 0.9, 1.08);
}

function getTimeFactor(dealYmd) {

  if (!dealYmd) return 1;

  const yyyy =
    Number(String(dealYmd).slice(0, 4));

  const mm =
    Number(String(dealYmd).slice(4, 6));

  const dealDate =
    new Date(yyyy, mm - 1, 1);

  const now = new Date();

  const monthsAgo =
    (now.getFullYear() - dealDate.getFullYear()) * 12 +
    (now.getMonth() - dealDate.getMonth());

  if (monthsAgo <= 3) return 1.01;

  if (monthsAgo <= 6) return 1;

  if (monthsAgo <= 12) return 0.98;

  if (monthsAgo <= 18) return 0.96;

  return 0.94;
}

function getComplexFactor(
  itemName,
  normalizedAptName
) {

  const item =
    normalizeAptName(itemName);

  if (
    !normalizedAptName ||
    normalizedAptName === '확인필요'
  ) {
    return 0.97;
  }

  if (item === normalizedAptName) {
    return 1.02;
  }

  if (
    item.includes(normalizedAptName) ||
    normalizedAptName.includes(item)
  ) {
    return 1;
  }

  return 0.95;
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
    const value =
      deals.reduce(
        (sum, d) =>
          sum + Number(d.adjustment[key] || 0),
        0
      ) / deals.length;

    return Math.round(value * 10) / 10;
  };

  return {
    floorPct: avg('floorPct'),
    timePct: avg('timePct'),
    complexPct: avg('complexPct'),
    totalPct: avg('totalPct')
  };
}

function filterItems(
  allItems,
  normalizedAptName,
  targetArea
) {

  let filtered = [...allItems];

  if (
    normalizedAptName &&
    normalizedAptName !== '확인필요'
  ) {

    const sameApt =
      filtered.filter(item => {

        const itemName =
          normalizeAptName(item.name);

        return (
          itemName &&
          (
            itemName.includes(normalizedAptName) ||
            normalizedAptName.includes(itemName)
          )
        );
      });

    if (sameApt.length) {
      filtered = sameApt;
    }
  }

  if (targetArea) {

    const areaFiltered =
      filtered.filter(item =>
        Math.abs(item.area - targetArea) <= 10
      );

    if (areaFiltered.length) {
      filtered = areaFiltered;
    }
  }

  return filtered;
}

async function fetchMonths(
  months,
  lawdCode,
  serviceKey
) {

  async function fetchWithTimeout(url, ms = 7000) {

    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () => controller.abort(),
        ms
      );

    try {

      const response =
        await fetch(url, {
          signal: controller.signal
        });

      return await response.text();

    } finally {
      clearTimeout(timer);
    }
  }

  const promises = months.map(
    dealYmd => {

      const url =
        'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade' +
        `?serviceKey=${serviceKey}` +
        `&LAWD_CD=${lawdCode}` +
        `&DEAL_YMD=${dealYmd}` +
        '&numOfRows=1000';

      return fetchWithTimeout(url)
        .then(xml => {

          const items =
            xml.match(/<item>[\s\S]*?<\/item>/g) || [];

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

              const price =
                Number(
                  String(priceText)
                    .replace(/[,\s]/g, '')
                ) * 10000;

              const area =
                Number(
                  String(areaText)
                    .replace(/,/g, '')
                    .trim()
                );

              const floor =
                Number(
                  String(floorText).trim()
                ) || 0;

              if (price && area) {
                return {
                  name,
                  price,
                  area,
                  floor,
                  dealYmd
                };
              }

              return null;

            })
            .filter(Boolean);

        })
        .catch(() => []);
    }
  );

  const results =
    await Promise.all(promises);

  return results.flat();
}

function getRecentMonths(totalMonths) {

  const result = [];
  const now = new Date();

  for (let i = 0; i < totalMonths; i++) {

    const date =
      new Date(
        now.getFullYear(),
        now.getMonth() - i,
        1
      );

    const yyyy =
      date.getFullYear();

    const mm =
      String(date.getMonth() + 1)
        .padStart(2, '0');

    result.push(`${yyyy}${mm}`);
  }

  return result;
}

function getMedian(values) {

  if (!values.length) return null;

  const sorted =
    [...values].sort((a, b) => a - b);

  const mid =
    Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }

  return Math.round(
    (sorted[mid - 1] + sorted[mid]) / 2
  );
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function getXml(xml, tag) {

  const match =
    xml.match(
      new RegExp(
        `<${tag}>([\\s\\S]*?)<\\/${tag}>`
      )
    );

  return match
    ? match[1].trim()
    : '';
}

function normalizeAptName(name = '') {

  return String(name || '')
    .replace(/\s/g, '')
    .replace(
      /아파트|APT|apt|단지|제\d+동|제\d+호/g,
      ''
    )
    .trim();
}
