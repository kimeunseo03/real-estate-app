module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ message: 'POST만 허용됩니다.' });
    }

    const { address, area, currentFloor, totalFloors, aptName } = req.body || {};
    const publicKey = process.env.PUBLIC_DATA_API_KEY;
    const vworldKey = process.env.VWORLD_API_KEY;

    if (!publicKey) return res.status(200).json({ investigationPrice: null, message: '❌ PUBLIC_DATA_API_KEY 없음' });
    if (!vworldKey) return res.status(200).json({ investigationPrice: null, message: '❌ VWORLD_API_KEY 없음' });
    if (!address) return res.status(200).json({ investigationPrice: null, message: '❌ 주소 없음' });

    const geo = await getVworldGeo(address, vworldKey);
    if (!geo || !geo.lawdCode) {
      return res.status(200).json({
        investigationPrice: null,
        message: '❌ VWorld 주소 변환 실패 또는 법정동코드 확인 실패',
        geo
      });
    }

    const months = getRecentMonths(24);
    const allItems = [];

    for (const dealYmd of months) {
      const url =
        'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade' +
        `?serviceKey=${publicKey}` +
        `&LAWD_CD=${geo.lawdCode}` +
        `&DEAL_YMD=${dealYmd}`;

      const response = await fetch(url);
      const xml = await response.text();

      if (xml.includes('SERVICE KEY IS NOT REGISTERED ERROR')) {
        return res.status(200).json({ investigationPrice: null, message: '❌ 공공데이터 API KEY 인증 실패' });
      }

      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

      for (const item of items) {
        const name = getXml(item, '아파트') || getXml(item, 'aptNm') || '';
        const priceText = getXml(item, '거래금액') || getXml(item, 'dealAmount');
        const areaText = getXml(item, '전용면적') || getXml(item, 'excluUseAr');
        const floorText = getXml(item, '층') || getXml(item, 'floor');

        const priceManwon = Number(String(priceText).replace(/,/g, '').replace(/\s/g, ''));
        const exclusiveArea = Number(String(areaText).replace(/,/g, '').trim());
        const floor = Number(String(floorText).trim());

        if (priceManwon && exclusiveArea) {
          allItems.push({
            name,
            price: priceManwon * 10000,
            area: exclusiveArea,
            floor
          });
        }
      }
    }

    if (!allItems.length) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
        geo,
        message: `❌ ${geo.lawdCode} 지역 최근 24개월 실거래 데이터 없음`
      });
    }

    const normalizedAptName = normalizeAptName(aptName);
    let filtered = allItems;

    if (normalizedAptName) {
      const sameComplex = filtered.filter(item =>
        normalizeAptName(item.name).includes(normalizedAptName) ||
        normalizedAptName.includes(normalizeAptName(item.name))
      );

      if (sameComplex.length) filtered = sameComplex;
    }

    const targetArea = Number(area || 0);

    if (targetArea) {
      const areaFiltered = filtered.filter(item => Math.abs(item.area - targetArea) <= 10);
      if (areaFiltered.length) filtered = areaFiltered;
    }

    if (!filtered.length) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
        totalRawCount: allItems.length,
        geo,
        message: '❌ 동일 단지/유사 면적 거래 없음'
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
      source: 'VWorld Geocoder + 공공데이터포털 실거래가 API',
      geo,
      aptName,
      lawdCode: geo.lawdCode,
      transactionCount: filtered.length,
      usedTransactionCount: pricesWithoutUpper.length,
      totalRawCount: allItems.length,
      upperPrice,
      middlePrice,
      lowerPrice,
      excludedUpperPrice: prices.length >= 3 ? upperPrice : null,
      appliedPriceType: useLower ? '하위값' : '중위값',
      investigationPrice: useLower ? lowerPrice : middlePrice,
      message: `✅ 성공: ${geo.lawdCode} / 동일단지·유사면적 기준 ${filtered.length}건 분석`
    });
  } catch (error) {
    return res.status(200).json({
      investigationPrice: null,
      transactionCount: 0,
      message: `❌ 서버 오류: ${error.message}`
    });
  }
};

async function getVworldGeo(address, key) {
  const types = ['road', 'parcel'];

  for (const type of types) {
    const url =
      'https://api.vworld.kr/req/address' +
      '?service=address' +
      '&request=getcoord' +
      '&version=2.0' +
      '&crs=EPSG:4326' +
      '&format=json' +
      '&refine=true' +
      '&simple=false' +
      `&type=${type}` +
      `&address=${encodeURIComponent(address)}` +
      `&key=${key}`;

    const response = await fetch(url);
    const data = await response.json().catch(() => null);

    const result = data?.response?.result;
    const point = result?.point;

    if (point?.x && point?.y) {
      const fullCode =
        result?.structure?.level4LC ||
        result?.structure?.level4LCode ||
        result?.structure?.level5LC ||
        result?.structure?.level5LCode ||
        result?.zipcode ||
        '';

      const lawdFullCode = String(fullCode || '').replace(/[^0-9]/g, '');
      const lawdCode = lawdFullCode.length >= 5 ? lawdFullCode.slice(0, 5) : fallbackLawdCode(address);

      return {
        x: point.x,
        y: point.y,
        lawdFullCode,
        lawdCode,
        type,
        refinedAddress: result?.text || address,
        mapImageUrl: makeStaticMapUrl(point.x, point.y, key)
      };
    }
  }

  return {
    lawdCode: fallbackLawdCode(address),
    refinedAddress: address,
    mapImageUrl: null
  };
}

function makeStaticMapUrl(x, y, key) {
  return (
    'https://api.vworld.kr/req/image' +
    '?service=image' +
    '&request=getmap' +
    '&version=2.0' +
    '&format=png' +
    '&crs=EPSG:4326' +
    `&center=${x},${y}` +
    '&level=17' +
    '&size=700,420' +
    `&markers=${x},${y}` +
    `&key=${key}`
  );
}

function fallbackLawdCode(address = '') {
  const text = String(address || '');

  const map = [
    ['서울특별시 종로구', '11110'], ['서울특별시 중구', '11140'], ['서울특별시 용산구', '11170'],
    ['서울특별시 성동구', '11200'], ['서울특별시 광진구', '11215'], ['서울특별시 동대문구', '11230'],
    ['서울특별시 중랑구', '11260'], ['서울특별시 성북구', '11290'], ['서울특별시 강북구', '11305'],
    ['서울특별시 도봉구', '11320'], ['서울특별시 노원구', '11350'], ['서울특별시 은평구', '11380'],
    ['서울특별시 서대문구', '11410'], ['서울특별시 마포구', '11440'], ['서울특별시 양천구', '11470'],
    ['서울특별시 강서구', '11500'], ['서울특별시 구로구', '11530'], ['서울특별시 금천구', '11545'],
    ['서울특별시 영등포구', '11560'], ['서울특별시 동작구', '11590'], ['서울특별시 관악구', '11620'],
    ['서울특별시 서초구', '11650'], ['서울특별시 강남구', '11680'], ['서울특별시 송파구', '11710'],
    ['서울특별시 강동구', '11740'],

    ['광주광역시 동구', '29110'], ['광주광역시 서구', '29140'], ['광주광역시 남구', '29155'],
    ['광주광역시 북구', '29170'], ['광주광역시 광산구', '29200'],

    ['나주시', '46170']
  ];

  const found = map.find(([name]) => text.includes(name) || text.includes(name.replace('특별시 ', '')) || text.includes(name.replace('광역시 ', '')));
  return found ? found[1] : null;
}

function normalizeAptName(name = '') {
  return String(name || '')
    .replace(/\s/g, '')
    .replace(/아파트|APT|apt|단지|동/g, '')
    .trim();
}

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
