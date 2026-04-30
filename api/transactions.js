module.exports = async function handler(req, res) {
  try {
    const { address, area, aptName } = req.body || {};
    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    if (!serviceKey) {
      return res.json({ investigationPrice: null, message: 'API KEY 없음' });
    }

    const lawdCode = getLawdCodeFromAddress(address);

    if (!lawdCode) {
      return res.json({ investigationPrice: null, message: '법정동코드 실패' });
    }

    const months = getRecentMonths(24);
    const allItems = [];

    for (const dealYmd of months) {
      const url =
        `https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade` +
        `?serviceKey=${serviceKey}&LAWD_CD=${lawdCode}&DEAL_YMD=${dealYmd}`;

      const resApi = await fetch(url);
      const xml = await resApi.text();

      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

      for (const item of items) {
        const name = getXml(item, '아파트') || getXml(item, 'aptNm');
        const price = Number(getXml(item, '거래금액').replace(/,/g, ''));
        const areaVal = Number(getXml(item, '전용면적'));
        const floor = Number(getXml(item, '층'));

        if (!price || !areaVal) continue;

        allItems.push({
          name,
          price: price * 10000,
          area: areaVal,
          floor
        });
      }
    }

    // 🔥 동일 단지 필터
    let filtered = allItems;

    if (aptName) {
      filtered = filtered.filter(item =>
        item.name && item.name.includes(aptName)
      );
    }

    // 면적 필터
    if (area) {
      filtered = filtered.filter(item =>
        Math.abs(item.area - area) <= 10
      );
    }

    if (!filtered.length) {
      return res.json({ investigationPrice: null, message: '거래 없음' });
    }

    const prices = filtered.map(v => v.price).sort((a, b) => a - b);

    const withoutTop = prices.length >= 3 ? prices.slice(0, -1) : prices;

    const result = {
      lower: withoutTop[0],
      middle: withoutTop[Math.floor(withoutTop.length / 2)],
      upper: prices[prices.length - 1]
    };

    return res.json({
      investigationPrice: result.middle,
      lowerPrice: result.lower,
      middlePrice: result.middle,
      upperPrice: result.upper,
      transactionCount: filtered.length,
      message: '성공'
    });

  } catch (e) {
    return res.json({ investigationPrice: null, message: e.message });
  }
};

// 📌 자동 법정동코드 생성
function getLawdCodeFromAddress(address = '') {
  const map = {
    서울: '11',
    부산: '26',
    대구: '27',
    인천: '28',
    광주: '29',
    대전: '30',
    울산: '31',
    세종: '36',
    경기: '41',
    강원: '42',
    충북: '43',
    충남: '44',
    전북: '45',
    전남: '46',
    경북: '47',
    경남: '48',
    제주: '50'
  };

  const region = Object.keys(map).find(k => address.includes(k));
  if (!region) return null;

  // 구 단위 랜덤 fallback
  return map[region] + '000';
}

function getXml(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>(.*?)<\/${tag}>`));
  return m ? m[1] : '';
}

function getRecentMonths(n) {
  const arr = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i);
    arr.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return arr;
}
