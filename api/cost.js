module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ message: 'POST만 허용됩니다.' });
    }

    const { address, area } = req.body || {};

    const costApproach = getFallback(address, area);

    return res.status(200).json({
      costApproach,
      officialPrice: null,
      method: getRegionLabel(address),
      message: '',
      fallback: true
    });

  } catch (error) {
    const { address, area } = req.body || {};
    return res.status(200).json({
      costApproach: getFallback(address, area),
      officialPrice: null,
      method: '지역별 추정',
      message: '',
      fallback: true
    });
  }
};

function getFallback(address = '', area = 0) {
  const targetArea = Number(String(area || '0').replace(/[^0-9.]/g, '')) || 0;
  if (!targetArea) return null;
  const { replacementCost, depreciationRate, landContribution } = getRegionParams(address);
  return Math.round(targetArea * replacementCost * (1 - depreciationRate) + landContribution);
}

function getRegionLabel(address = '') {
  const addr = String(address);
  if (addr.includes('서울')) return '지역별 추정 (서울)';
  if (['수원','성남','용인','고양','화성','부천','안산','안양','평택','시흥'].some(v => addr.includes(v))) return '지역별 추정 (수도권 주요도시)';
  if (['부산','대구','인천','광주','대전','울산'].some(v => addr.includes(v))) return '지역별 추정 (광역시)';
  if (addr.includes('세종')) return '지역별 추정 (세종)';
  if (['전주','청주','창원','포항','천안','전남','전북','경남','경북','충남','충북'].some(v => addr.includes(v))) return '지역별 추정 (지방 중소도시)';
  return '지역별 추정 (지방 소도시)';
}

function getRegionParams(address = '') {
  const addr = String(address);
  if (addr.includes('서울')) return { replacementCost: 5200000, depreciationRate: 0.32, landContribution: 800000000 };
  if (['수원','성남','용인','고양','화성','부천','안산','안양','평택','시흥'].some(v => addr.includes(v))) return { replacementCost: 4600000, depreciationRate: 0.32, landContribution: 400000000 };
  if (['부산','대구','인천','광주','대전','울산'].some(v => addr.includes(v))) return { replacementCost: 4200000, depreciationRate: 0.32, landContribution: 250000000 };
  if (addr.includes('세종')) return { replacementCost: 4400000, depreciationRate: 0.30, landContribution: 300000000 };
  if (['전주','청주','창원','포항','천안','전남','전북','경남','경북','충남','충북'].some(v => addr.includes(v))) return { replacementCost: 3800000, depreciationRate: 0.35, landContribution: 120000000 };
  return { replacementCost: 3400000, depreciationRate: 0.38, landContribution: 80000000 };
}
