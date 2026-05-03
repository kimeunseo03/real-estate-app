// api/cost.js
// Vworld 속성 서비스 기반 공동주택 공시가격 조회 → 원가법 계산
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ message: 'POST만 허용됩니다.' });
    }

    const { address, aptName, area, unitNumber } = req.body || {};
    const vworldKey = process.env.VWORLD_API_KEY;

    if (!vworldKey) {
      return res.status(200).json({
        costApproach: getFallback(address, area),
        officialPrice: null,
        method: '지역별 추정 (VWORLD_API_KEY 없음)',
        message: '⚠️ VWORLD_API_KEY 환경변수를 확인하세요.',
        fallback: true
      });
    }

    // 층·호 파싱
    const floorMatch = String(unitNumber || '').match(/제\s*(\d+)층/);
    const hoMatch = String(unitNumber || '').match(/제\s*(\d+)호/);
    const floorNm = floorMatch ? floorMatch[1] : '';
    const hoNm = hoMatch ? hoMatch[1] : '';
    const normalizedApt = normalizeAptName(aptName);
    const targetArea = Number(String(area || '0').replace(/[^0-9.]/g, '')) || 0;

    // Vworld 속성 서비스 요청
    // LT_C_AAPHUS: 공동주택가격 레이어
    const cql = buildCqlFilter(normalizedApt, floorNm, hoNm, targetArea);
    const url =
      'https://api.vworld.kr/req/data' +
      '?service=data' +
      '&request=GetFeature' +
      '&data=LT_C_AAPHUS' +
      '&format=json' +
      '&errorformat=json' +
      '&size=10' +
      '&page=1' +
      `&key=${vworldKey}` +
      `&domain=real-estate-p0qonhy0z-dmstj4677-6527s-projects.vercel.app` +
      (cql ? `&cql=${encodeURIComponent(cql)}` : '');

    let officialPrice = null;
    let method = '';
    let apiMessage = '';

    try {
      const response = await Promise.race([
        fetch(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
      ]);
      const data = await response.json();

      const features =
        data?.response?.result?.featureCollection?.features ||
        data?.response?.features ||
        [];

      if (features.length > 0) {
        // 면적 가장 유사한 항목 선택
        const sorted = features
          .map(f => f.properties || f)
          .filter(p => p.pbIntfPc)
          .sort((a, b) => {
            const da = Math.abs(Number(a.prvuseAr || 0) - targetArea);
            const db = Math.abs(Number(b.prvuseAr || 0) - targetArea);
            return da - db;
          });

        if (sorted.length > 0) {
          const best = sorted[0];
          officialPrice = Number(String(best.pbIntfPc || '0').replace(/[,\s]/g, ''));
          apiMessage = `✅ 공시가격 조회 성공 (${best.aphusNm || ''} ${best.floorNm || ''}층 ${best.hoNm || ''}호, ${best.prvuseAr || ''}㎡)`;
          method = 'Vworld 공시가격 역산 (공시가격 ÷ 0.70)';
        } else {
          apiMessage = '⚠️ 조건에 맞는 공시가격 없음 — 지역별 추정값 사용';
        }
      } else {
        apiMessage = `⚠️ Vworld 조회 결과 없음 — 지역별 추정값 사용`;
        // 응답 상태 로깅
        if (data?.response?.status) {
          apiMessage += ` (${data.response.status})`;
        }
      }
    } catch (e) {
      apiMessage = `⚠️ Vworld API 오류: ${e.message} — 지역별 추정값 사용`;
    }

    // 원가법 계산
    let costApproach = null;
    if (officialPrice && officialPrice > 0) {
      costApproach = Math.round(officialPrice / 0.70);
      if (!method) method = 'Vworld 공시가격 역산 (공시가격 ÷ 0.70)';
    } else {
      costApproach = getFallback(address, area);
      method = method || `지역별 추정 (재조달원가 기반)`;
    }

    return res.status(200).json({
      costApproach,
      officialPrice,
      method,
      message: apiMessage,
      fallback: !officialPrice
    });

  } catch (error) {
    const { address, area } = req.body || {};
    return res.status(200).json({
      costApproach: getFallback(address, area),
      officialPrice: null,
      method: '지역별 추정 (서버 오류 폴백)',
      message: `⚠️ ${error.message}`,
      fallback: true
    });
  }
};

// CQL 필터 생성
function buildCqlFilter(aptName, floorNm, hoNm, area) {
  const conditions = [];
  if (aptName) conditions.push(`aphusNm LIKE '%${aptName}%'`);
  if (floorNm) conditions.push(`floorNm = '${floorNm}'`);
  if (hoNm) conditions.push(`hoNm = '${hoNm}'`);
  return conditions.join(' AND ');
}

// 지역별 원가법 추정 폴백
function getFallback(address = '', area = 0) {
  const addr = String(address);
  const targetArea = Number(String(area || '0').replace(/[^0-9.]/g, '')) || 0;
  if (!targetArea) return null;

  let replacementCost, depreciationRate, landContribution;

  if (addr.includes('서울')) {
    replacementCost = 5200000; depreciationRate = 0.32; landContribution = 800000000;
  } else if (['수원','성남','용인','고양','화성','부천','안산','안양','평택','시흥'].some(v => addr.includes(v))) {
    replacementCost = 4600000; depreciationRate = 0.32; landContribution = 400000000;
  } else if (['부산','대구','인천','광주','대전','울산'].some(v => addr.includes(v))) {
    replacementCost = 4200000; depreciationRate = 0.32; landContribution = 250000000;
  } else if (addr.includes('세종')) {
    replacementCost = 4400000; depreciationRate = 0.30; landContribution = 300000000;
  } else if (['전주','청주','창원','포항','천안','전남','전북','경남','경북','충남','충북'].some(v => addr.includes(v))) {
    replacementCost = 3800000; depreciationRate = 0.35; landContribution = 120000000;
  } else {
    replacementCost = 3400000; depreciationRate = 0.38; landContribution = 80000000;
  }

  return Math.round(targetArea * replacementCost * (1 - depreciationRate) + landContribution);
}

function normalizeAptName(name = '') {
  return String(name || '')
    .replace(/\s/g, '')
    .replace(/아파트|APT|apt|단지|제\d+동|제\d+호/g, '')
    .trim();
}
