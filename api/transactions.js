export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'POST만 허용됩니다.' });
    }

    const { address, area, currentFloor, totalFloors } = req.body || {};
    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    if (!serviceKey) {
      return res.status(200).json({
        investigationPrice: null,
        source: '공공데이터포털 실거래가 API',
        transactionCount: 0,
        message: 'PUBLIC_DATA_API_KEY 환경변수가 없습니다.'
      });
    }

    const lawdCode = getLawdCode(address);

    if (!lawdCode) {
      return res.status(200).json({
        investigationPrice: null,
        source: '공공데이터포털 실거래가 API',
        transactionCount: 0,
        message: `주소에서 법정동코드를 찾지 못했습니다: ${address}`
      });
    }

    const months = getRecentMonths(36);
    const allItems = [];

    for (const dealYmd of months) {
      const url =
        'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade' +
        `?serviceKey=${serviceKey}` +
        `&LAWD_CD=${lawdCode}` +
        `&DEAL_YMD=${dealYmd}`;

      const response = await fetch(url);
      const xml = await response.text();

      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

      for (const item of items) {
        const priceText = getXml(item, 'dealAmount') || getXml(item, '거래금액');
        const areaText = getXml(item, 'excluUseAr') || getXml(item, '전용면적');
        const floorText = getXml(item, 'floor') || getXml(item, '층');

        const priceManwon = Number(String(priceText).replace(/,/g, '').replace(/\s/g, ''));
        const exclusiveArea = Number(String(areaText).replace(/,/g, '').trim());
        const floor = Number(String(floorText).trim());

        if (priceManwon && exclusiveArea) {
          allItems.push({
            price: priceManwon * 10000,
            area: exclusiveArea,
            floor
          });
        }
      }
    }

    const targetArea = Number(area || 0);

    let filtered = allItems.filter((item) => {
      if (!targetArea) return true;
      return Math.abs(item.area - targetArea) <= 10;
    });

    if (!filtered.length && allItems.length) {
      filtered = allItems;
    }

    if (!allItems.length) {
      return res.status(200).json({
        investigationPrice: null,
        source: '공공데이터포털 실거래가 API',
        transactionCount: 0,
        message: `최근 36개월 ${lawdCode} 지역 실거래 데이터가 없습니다.`
      });
    }

    if (!filtered.length) {
      return res.status(200).json({
        investigationPrice: null,
        source: '공공데이터포털 실거래가 API',
        transactionCount: 0,
        message: `거래 ${allItems.length}건은 있으나 전용면적 ${targetArea}㎡ 유사 거래가 없습니다.`
      });
    }

    const prices = filtered.map((item) => item.price).sort((a, b) => a - b);

    const lowerPrice = prices[0];
    const middlePrice = prices[Math.floor(prices.length / 2)];
    const upperPrice = prices[prices.length - 1];

    const medianFloor = totalFloors ? totalFloors / 2 : 0;
    const useLower = currentFloor && medianFloor ? currentFloor < medianFloor : true;

    return res.status(200).json({
      source: '공공데이터포털 실거래가 API',
      transactionCount: filtered.length,
      totalRawCount: allItems.length,
      upperPrice,
      middlePrice,
      lowerPrice,
      appliedPriceType: useLower ? '하위값' : '중위값',
      investigationPrice: useLower ? lowerPrice : middlePrice
    });
  } catch (error) {
    return res.status(200).json({
      investigationPrice: null,
      source: '공공데이터포털 실거래가 API',
      transactionCount: 0,
      message: `실거래가 API 조회 실패: ${error.message}`
    });
  }
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

function getLawdCode(address = '') {
  if (address.includes('나주시')) return '46170';
  if (address.includes('동대문구')) return '11230';

  return null;
}
