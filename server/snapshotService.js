const { getCategoryShares } = require('./contextBuilder');

function buildSnapshot(holdings, date) {
  const total = holdings.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const shares = getCategoryShares(holdings);
  const byCategory = Object.fromEntries(shares.map((item) => [item.category, item.amount]));
  return {
    date,
    total,
    byCategory,
  };
}

function upsertPortfolioSnapshot(portfolio, date) {
  if (!portfolio || !date || !Array.isArray(portfolio.holdings) || !portfolio.holdings.length) {
    return false;
  }
  if (!Array.isArray(portfolio.snapshots)) {
    portfolio.snapshots = [];
  }
  const snapshot = buildSnapshot(portfolio.holdings, date);
  portfolio.snapshots = portfolio.snapshots.filter((item) => item.date !== date);
  portfolio.snapshots.push(snapshot);
  portfolio.snapshots.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return true;
}

module.exports = {
  buildSnapshot,
  upsertPortfolioSnapshot,
};
