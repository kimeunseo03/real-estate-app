module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        error: 'POST만 허용됩니다.',
        message: 'POST만 허용됩니다.'
      });
    }

    const { address, area, currentFloor, totalFloors } = req.body || {};
    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    if (!serviceKey) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
        message: '❌ API KEY 없음: Vercel 환경변수 PUBLIC_DATA_API_KEY를 확인하세요.'
      });
    }

    const lawdCode = getLawdCode(address);

    if (!lawdCode) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
        message: `❌ 법정동코드 매칭 실패: ${address}`
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

      if (xml.includes('SERVICE KEY IS NOT REGISTERED ERROR')) {
        return res.status(200).json({
          investigationPrice: null,
          transactionCount: 0,
          message: '❌ API KEY 인증 실패'
        });
      }

      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

      for (const item of items) {
        const priceText = getXml(item, '거래금액') || getXml(item, 'dealAmount');
        const areaText = getXml(item, '전용면적') || getXml(item, 'excluUseAr');
        const floorText = getXml(item, '층') || getXml(item, 'floor');

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

    if (!allItems.length) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
        message: `❌ ${lawdCode} 지역 최근 36개월 실거래 데이터 없음`
      });
    }

    const targetArea = Number(area || 0);

    let filtered = allItems.filter((item) => {
      if (!targetArea) return true;
      return Math.abs(item.area - targetArea) <= 10;
    });

    if (!filtered.length) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
        message: `❌ 면적 ${targetArea}㎡ 유사 거래 없음. 전체 거래 ${allItems.length}건`
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
      investigationPrice: useLower ? lowerPrice : middlePrice,
      message: `✅ 성공: 유사 면적 거래 ${filtered.length}건 / 전체 ${allItems.length}건`
    });

  } catch (error) {
    return res.status(200).json({
      investigationPrice: null,
      transactionCount: 0,
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

function getLawdCode(address = '') {
  if (address.includes('나주시')) return '46170';
  if (address.includes('동대문구')) return '11230';

  return null;
}
