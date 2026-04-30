module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        error: 'POST만 허용됩니다.',
        message: 'POST만 허용됩니다.'
      });
    }

    const { address, area, currentFloor, totalFloors, aptName } = req.body || {};
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

    const months = getRecentMonths(24);
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
        lawdCode,
        message: `❌ ${lawdCode} 지역 최근 24개월 실거래 데이터 없음`
      });
    }

    const targetArea = Number(area || 0);
    const normalizedAptName = normalizeAptName(aptName);
    console.log('등기부 단지명:', normalizedAptName);
    console.log('API 단지명 샘플:', allItems.slice(0, 5).map(i => i.name));
    let filtered = allItems;

    if (normalizedAptName && normalizedAptName !== '확인필요') {
      const sameApt = filtered.filter((item) => {
        const itemName = normalizeAptName(item.name);
        return itemName && (
          itemName.includes(normalizedAptName) ||
          normalizedAptName.includes(itemName)
        );
      });

      if (sameApt.length) {
        filtered = sameApt;
      }
    }

    if (targetArea) {
      const areaFiltered = filtered.filter((item) => {
        return Math.abs(item.area - targetArea) <= 10;
      });

      if (areaFiltered.length) {
        filtered = areaFiltered;
      }
    }

    if (!filtered.length) {
      return res.status(200).json({
        investigationPrice: null,
        transactionCount: 0,
        totalRawCount: allItems.length,
        lawdCode,
        message: `❌ 유사 거래 없음. 전체 거래 ${allItems.length}건`
      });
    }

    const prices = filtered.map((item) => item.price).sort((a, b) => a - b);

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
      upperPrice,
      middlePrice,
      lowerPrice,
      excludedUpperPrice: prices.length >= 3 ? upperPrice : null,
      appliedPriceType: useLower ? '하위값' : '중위값',
      investigationPrice: useLower ? lowerPrice : middlePrice,
      message: `✅ 성공: 유사 거래 ${filtered.length}건 기준 산정`
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

function normalizeAptName(name = '') {
  return String(name || '')
    .replace(/\s/g, '')
    .replace(/아파트|APT|apt|단지|제\d+동|제\d+호/g, '')
    .trim();
}

function getLawdCode(address = '') {
  const text = String(address || '');

  if (text.includes('광주광역시 동구') || text.includes('광주 동구')) return '29110';
  if (text.includes('광주광역시 서구') || text.includes('광주 서구')) return '29140';
  if (text.includes('광주광역시 남구') || text.includes('광주 남구')) return '29155';
  if (text.includes('광주광역시 북구') || text.includes('광주 북구')) return '29170';
  if (text.includes('광주광역시 광산구') || text.includes('광주 광산구')) return '29200';

  if (text.includes('나주시')) return '46170';

  if (text.includes('서울특별시 동대문구') || text.includes('동대문구')) return '11230';
  if (text.includes('서울특별시 강남구') || text.includes('강남구')) return '11680';
  if (text.includes('서울특별시 송파구') || text.includes('송파구')) return '11710';
  if (text.includes('서울특별시 강동구') || text.includes('강동구')) return '11740';
  if (text.includes('서울특별시 서초구') || text.includes('서초구')) return '11650';

  return null;
}
