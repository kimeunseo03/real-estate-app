module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ message: 'POST만 허용됩니다.' });
    }

    const { address } = req.body || {};
    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    if (!serviceKey) {
      return res.status(200).json({
        buildingInfo: null,
        message: '❌ API KEY 없음'
      });
    }

    const parsed = parseAddressForBuilding(address);

    if (!parsed) {
      return res.status(200).json({
        buildingInfo: null,
        message: '❌ 주소에서 지번 추출 실패'
      });
    }

    const regionCode = await getFullRegionCode(address, serviceKey);

    if (!regionCode) {
      return res.status(200).json({
        buildingInfo: null,
        message: '❌ 법정동코드 10자리 조회 실패'
      });
    }

    const sigunguCd = regionCode.slice(0, 5);
    const bjdongCd = regionCode.slice(5, 10);

    const bun = String(parsed.bun).padStart(4, '0');
    const ji = String(parsed.ji || 0).padStart(4, '0');

    const url =
      'https://apis.data.go.kr/1613000/BldRgstService_v2/getBrTitleInfo' +
      `?serviceKey=${serviceKey}` +
      '&numOfRows=10&pageNo=1&type=json' +
      `&sigunguCd=${sigunguCd}` +
      `&bjdongCd=${bjdongCd}` +
      `&bun=${bun}` +
      `&ji=${ji}`;

    const response = await fetch(url);
    const data = await response.json();

    let items =
      data?.response?.body?.items?.item ||
      data?.items?.item ||
      [];

    if (!Array.isArray(items)) items = items ? [items] : [];

    const item =
      items.find(v => String(v.regstrKindCdNm || '').includes('표제부')) ||
      items[0];

    if (!item) {
      return res.status(200).json({
        buildingInfo: null,
        message: '❌ 건축물대장 표제부 데이터 없음'
      });
    }

    const approvalDateRaw =
      item.useAprDay ||
      item.useaprDay ||
      item.useAprDate ||
      '';

    const buildYear = approvalDateRaw
      ? Number(String(approvalDateRaw).slice(0, 4))
      : null;

    const householdCount =
      Number(item.hhldCnt || item.hoCnt || item.fmlyCnt || 0) || null;

    const parkingCount =
      Number(item.totPkngCnt || item.indrMechUtcnt || item.oudrMechUtcnt || 0) || null;

    const groundFloorCount =
      Number(item.grndFlrCnt || 0) || null;

    const undergroundFloorCount =
      Number(item.ugrndFlrCnt || 0) || null;

    const buildingInfo = {
      buildYear,
      approvalDate: formatApprovalDate(approvalDateRaw),
      householdCount,
      parkingCount,
      parkingPerHousehold:
        householdCount && parkingCount
          ? Math.round((parkingCount / householdCount) * 100) / 100
          : null,
      groundFloorCount,
      undergroundFloorCount,
      structure: item.strctCdNm || '',
      mainPurpose: item.mainPurpsCdNm || '',
      buildingName: item.bldNm || '',
      source: '건축물대장 API'
    };

    return res.status(200).json({
      buildingInfo,
      message: '✅ 건축물대장 조회 성공'
    });

  } catch (error) {
    return res.status(200).json({
      buildingInfo: null,
      message: `❌ 서버 오류: ${error.message}`
    });
  }
};

function parseAddressForBuilding(address = '') {
  const text = String(address || '').trim();

  const matches = [...text.matchAll(/(\d+)(?:-(\d+))?/g)];
  if (!matches.length) return null;

  const last = matches[matches.length - 1];

  return {
    bun: Number(last[1]),
    ji: Number(last[2] || 0)
  };
}

async function getFullRegionCode(address = '', serviceKey = '') {
  const text = String(address || '').replace(/\s+/g, ' ').trim();
  const parts = text.split(' ').filter(Boolean);

  const candidates = [];

  for (let i = Math.min(parts.length, 4); i >= 2; i--) {
    candidates.push(parts.slice(0, i).join(' '));
  }

  for (const keyword of candidates) {
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

    const legalDong = parts.find(v => v.endsWith('동') || v.endsWith('리') || v.endsWith('읍') || v.endsWith('면')) || '';

    const exact = rows.find(row => {
      const name = row.locatadd_nm || row.locallow_nm || '';
      const code = String(row.region_cd || row.regionCd || '');
      return (
        code.length >= 10 &&
        !code.endsWith('00000') &&
        (!legalDong || name.includes(legalDong))
      );
    });

    if (exact) {
      return String(exact.region_cd || exact.regionCd).slice(0, 10);
    }
  }

  return null;
}

function formatApprovalDate(v = '') {
  const s = String(v || '').replace(/[^0-9]/g, '');
  if (s.length !== 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
