module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST만 허용됩니다.', message: 'POST만 허용됩니다.' });
    }

    const { address, area, currentFloor, totalFloors, aptName } = req.body || {};
    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    if (!serviceKey) {
      return res.status(200).json({
        investigationPrice: null, transactionCount: 0,
        message: '❌ API KEY 없음: Vercel 환경변수 PUBLIC_DATA_API_KEY를 확인하세요.'
      });
    }

    const lawdCode = await getLawdCode(address, serviceKey);
    if (!lawdCode) {
      return res.status(200).json({
        investigationPrice: null, transactionCount: 0,
        message: `❌ 법정동코드 매칭 실패: ${address}`
      });
    }

    const months = getRecentMonths(24);

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
      // serviceKey는 이미 인코딩된 키이므로 그대로 사용 (이중인코딩 방지)
      const url =
        'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade' +
        `?serviceKey=${serviceKey}` +
        `&LAWD_CD=${lawdCode}` +
        `&DEAL_YMD=${dealYmd}` +
        `&numOfRows=100`;
      return fetchWithTimeout(url, 8000)
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

    // 버그 수정: allItems 이중 선언 제거 — results.flat() 한 번만 사용
    const results = await Promise.all(promises);
    const allItems = results.flat();

    if (!allItems.length) {
      return res.status(200).json({
        investigationPrice: null, transactionCount: 0,
        lawdCode, totalRawCount: 0,
        message: `❌ ${lawdCode} 지역 최근 24개월 실거래 데이터 없음`
      });
    }

    const targetArea = Number(area || 0);
    const normalizedAptName = normalizeAptName(aptName);

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

  // 버그 수정: serviceKey 이중인코딩 제거 — 이미 인코딩된 키는 그대로 전달
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

    // 다양한 응답 구조 대응
    rows =
      data?.StanReginCd?.[1]?.row ||
      data?.response?.body?.items?.item ||
      data?.items?.item ||
      [];

    if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  } catch (e) {
    console.error('getLawdCode fetch error:', e.message);
    return null;
  }

  // 시도+시군구 정확 매칭 우선
  const exact = rows.find(row => {
    const name = row.locatadd_nm || row.locallow_nm || '';
    const code = String(row.region_cd || row.regionCd || '');
    return name.includes(keyword) && code.length >= 5 && code.endsWith('00000');
  });
  if (exact) return String(exact.region_cd || exact.regionCd).slice(0, 5);

  // 시군구만으로 폴백
  const fallback = rows.find(row => {
    const name = row.locatadd_nm || row.locallow_nm || '';
    const code = String(row.region_cd || row.regionCd || '');
    return name.includes(sigungu) && code.length >= 5 && code.endsWith('00000');
  });
  if (fallback) return String(fallback.region_cd || fallback.regionCd).slice(0, 5);

  // 끝자리 무관 최후 폴백
  const loose = rows.find(row => {
    const name = row.locatadd_nm || row.locallow_nm || '';
    return name.includes(sigungu);
  });
  return loose ? String(loose.region_cd || loose.regionCd).slice(0, 5) : null;
}
