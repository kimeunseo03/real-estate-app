module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ message: 'POST만 허용됩니다.' });
    }

    const { address } = req.body || {};
    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    if (!serviceKey) {
      return res.status(200).json({ lawdCode: null, message: '❌ API KEY 없음' });
    }

    const lawdCode = await getLawdCode(address, serviceKey);

    return res.status(200).json({
      lawdCode,
      message: lawdCode ? `✅ 법정동코드 매칭 성공: ${lawdCode}` : `❌ 법정동코드 매칭 실패: ${address}`
    });
  } catch (error) {
    return res.status(200).json({ lawdCode: null, message: `❌ 서버 오류: ${error.message}` });
  }
};

async function getLawdCode(address = '', serviceKey = '') {
  const text = String(address || '').replace(/\s+/g, ' ').trim();
  const parts = text.split(' ');
  const sido = parts[0] || '';
  const sigungu = parts[1] || '';
  if (!sido || !sigungu) return null;

  const keyword = `${sido} ${sigungu}`;
  const url =
    'https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList' +
    `?serviceKey=${serviceKey}` +
    '&type=json&pageNo=1&numOfRows=1000' +
    `&locatadd_nm=${encodeURIComponent(keyword)}`;

  const response = await fetch(url);
  const data = await response.json();

  let rows =
    data?.StanReginCd?.[1]?.row ||
    data?.response?.body?.items?.item ||
    data?.items?.item ||
    [];

  if (!Array.isArray(rows)) rows = rows ? [rows] : [];

  const exact = rows.find(row => {
    const name = row.locatadd_nm || row.locallow_nm || '';
    const code = String(row.region_cd || row.regionCd || '');
    return name.includes(keyword) && code.length >= 5 && code.endsWith('00000');
  });

  if (exact) return String(exact.region_cd || exact.regionCd).slice(0, 5);

  const fallback = rows.find(row => {
    const name = row.locatadd_nm || row.locallow_nm || '';
    const code = String(row.region_cd || row.regionCd || '');
    return name.includes(sigungu) && code.length >= 5 && code.endsWith('00000');
  });

  if (fallback) return String(fallback.region_cd || fallback.regionCd).slice(0, 5);

  const loose = rows.find(row => {
    const name = row.locatadd_nm || row.locallow_nm || '';
    return name.includes(sigungu);
  });

  return loose ? String(loose.region_cd || loose.regionCd).slice(0, 5) : null;
}
