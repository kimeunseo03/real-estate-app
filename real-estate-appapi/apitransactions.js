export default async function handler(req, res) {
  try {
    const { lawdCode, dealYmd, area } = req.body;

    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    const url = `https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev?serviceKey=${serviceKey}&LAWD_CD=${lawdCode}&DEAL_YMD=${dealYmd}`;

    const response = await fetch(url);
    const text = await response.text();

    // XML → JSON 변환 필요
    const items = text.match(/<item>([\s\S]*?)<\/item>/g) || [];

    const parsed = items.map(item => {
      const price = Number(item.match(/<거래금액>(.*?)<\/거래금액>/)?.[1].replace(/,/g, '') || 0);
      const areaVal = Number(item.match(/<전용면적>(.*?)<\/전용면적>/)?.[1] || 0);
      const floor = Number(item.match(/<층>(.*?)<\/층>/)?.[1] || 0);

      return { price, area: areaVal, floor };
    });

    // 면적 필터 (±3㎡)
    const filtered = parsed.filter(p => Math.abs(p.area - area) < 3);

    if (!filtered.length) {
      return res.json({
        investigationPrice: null,
        source: '실거래가 없음'
      });
    }

    const prices = filtered.map(p => p.price).sort((a,b)=>a-b);

    const middle = prices[Math.floor(prices.length / 2)];

    res.json({
      upperPrice: prices[prices.length - 1],
      middlePrice: middle,
      lowerPrice: prices[0],
      investigationPrice: middle,
      source: '실거래가 기반'
    });

  } catch (e) {
    res.status(500).json({ error: '실거래가 API 실패' });
  }
}