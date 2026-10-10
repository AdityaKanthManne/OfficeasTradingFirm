/**
 * classify.js — lightweight ticker → asset class / sector lookup.
 *
 * No market-data dependency: a curated map of common tickers plus a few
 * heuristics. Unknown tickers are treated as single-name equities and the
 * AI analysts are told the classification is a guess.
 */

// cls: equity | bond | cash | crypto | commodity | realestate
// fund: true for diversified funds/ETFs (exempt from single-name limits)
const T = (cls, sector, name, extra = {}) => ({ cls, sector, name, ...extra })

const MAP = {
  // ---- Mega-cap tech / growth
  AAPL: T('equity', 'Technology', 'Apple'),
  MSFT: T('equity', 'Technology', 'Microsoft'),
  NVDA: T('equity', 'Technology', 'NVIDIA', { vol: 0.50 }),
  AMD:  T('equity', 'Technology', 'AMD', { vol: 0.50 }),
  INTC: T('equity', 'Technology', 'Intel'),
  AVGO: T('equity', 'Technology', 'Broadcom', { vol: 0.40 }),
  TSM:  T('equity', 'Technology', 'Taiwan Semiconductor', { vol: 0.38 }),
  ORCL: T('equity', 'Technology', 'Oracle'),
  CRM:  T('equity', 'Technology', 'Salesforce'),
  ADBE: T('equity', 'Technology', 'Adobe'),
  PLTR: T('equity', 'Technology', 'Palantir', { vol: 0.65 }),
  SNOW: T('equity', 'Technology', 'Snowflake', { vol: 0.55 }),
  SHOP: T('equity', 'Technology', 'Shopify', { vol: 0.55 }),
  IBM:  T('equity', 'Technology', 'IBM', { vol: 0.22 }),
  GOOGL: T('equity', 'Communication Services', 'Alphabet'),
  GOOG: T('equity', 'Communication Services', 'Alphabet'),
  META: T('equity', 'Communication Services', 'Meta Platforms', { vol: 0.40 }),
  NFLX: T('equity', 'Communication Services', 'Netflix', { vol: 0.40 }),
  DIS:  T('equity', 'Communication Services', 'Disney'),
  T:    T('equity', 'Communication Services', 'AT&T', { vol: 0.20 }),
  VZ:   T('equity', 'Communication Services', 'Verizon', { vol: 0.18 }),
  AMZN: T('equity', 'Consumer Discretionary', 'Amazon', { vol: 0.35 }),
  TSLA: T('equity', 'Consumer Discretionary', 'Tesla', { vol: 0.60 }),
  NKE:  T('equity', 'Consumer Discretionary', 'Nike'),
  HD:   T('equity', 'Consumer Discretionary', 'Home Depot', { vol: 0.22 }),
  MCD:  T('equity', 'Consumer Discretionary', "McDonald's", { vol: 0.17 }),
  SBUX: T('equity', 'Consumer Discretionary', 'Starbucks'),
  // ---- Financials
  JPM:  T('equity', 'Financials', 'JPMorgan Chase', { vol: 0.24 }),
  BAC:  T('equity', 'Financials', 'Bank of America', { vol: 0.28 }),
  GS:   T('equity', 'Financials', 'Goldman Sachs', { vol: 0.28 }),
  MS:   T('equity', 'Financials', 'Morgan Stanley', { vol: 0.28 }),
  WFC:  T('equity', 'Financials', 'Wells Fargo', { vol: 0.28 }),
  V:    T('equity', 'Financials', 'Visa', { vol: 0.20 }),
  MA:   T('equity', 'Financials', 'Mastercard', { vol: 0.22 }),
  'BRK.B': T('equity', 'Financials', 'Berkshire Hathaway', { vol: 0.17 }),
  BRKB: T('equity', 'Financials', 'Berkshire Hathaway', { vol: 0.17 }),
  COIN: T('equity', 'Financials', 'Coinbase', { vol: 0.80, spec: true }),
  // ---- Health care
  JNJ:  T('equity', 'Health Care', 'Johnson & Johnson', { vol: 0.16 }),
  UNH:  T('equity', 'Health Care', 'UnitedHealth', { vol: 0.25 }),
  PFE:  T('equity', 'Health Care', 'Pfizer', { vol: 0.24 }),
  LLY:  T('equity', 'Health Care', 'Eli Lilly', { vol: 0.32 }),
  MRK:  T('equity', 'Health Care', 'Merck', { vol: 0.20 }),
  ABBV: T('equity', 'Health Care', 'AbbVie', { vol: 0.22 }),
  // ---- Staples / energy / industrials / utilities
  KO:   T('equity', 'Consumer Staples', 'Coca-Cola', { vol: 0.15 }),
  PEP:  T('equity', 'Consumer Staples', 'PepsiCo', { vol: 0.16 }),
  PG:   T('equity', 'Consumer Staples', 'Procter & Gamble', { vol: 0.15 }),
  WMT:  T('equity', 'Consumer Staples', 'Walmart', { vol: 0.18 }),
  COST: T('equity', 'Consumer Staples', 'Costco', { vol: 0.20 }),
  XOM:  T('equity', 'Energy', 'ExxonMobil', { vol: 0.25 }),
  CVX:  T('equity', 'Energy', 'Chevron', { vol: 0.25 }),
  BA:   T('equity', 'Industrials', 'Boeing', { vol: 0.35 }),
  CAT:  T('equity', 'Industrials', 'Caterpillar', { vol: 0.28 }),
  GE:   T('equity', 'Industrials', 'GE Aerospace', { vol: 0.30 }),
  UPS:  T('equity', 'Industrials', 'UPS', { vol: 0.25 }),
  NEE:  T('equity', 'Utilities', 'NextEra Energy', { vol: 0.22 }),
  DUK:  T('equity', 'Utilities', 'Duke Energy', { vol: 0.17 }),
  SO:   T('equity', 'Utilities', 'Southern Co', { vol: 0.17 }),
  // ---- Broad equity funds
  SPY:  T('equity', 'Broad Market', 'S&P 500 ETF', { fund: true, vol: 0.17 }),
  VOO:  T('equity', 'Broad Market', 'Vanguard S&P 500 ETF', { fund: true, vol: 0.17 }),
  IVV:  T('equity', 'Broad Market', 'iShares S&P 500 ETF', { fund: true, vol: 0.17 }),
  VTI:  T('equity', 'Broad Market', 'Vanguard Total Market ETF', { fund: true, vol: 0.17 }),
  QQQ:  T('equity', 'Technology', 'Nasdaq-100 ETF', { fund: true, vol: 0.23 }),
  DIA:  T('equity', 'Broad Market', 'Dow Jones ETF', { fund: true, vol: 0.16 }),
  IWM:  T('equity', 'Small Cap', 'Russell 2000 ETF', { fund: true, vol: 0.23 }),
  VXUS: T('equity', 'International', 'Vanguard Total Intl ETF', { fund: true, vol: 0.16 }),
  EFA:  T('equity', 'International', 'MSCI EAFE ETF', { fund: true, vol: 0.16 }),
  VEA:  T('equity', 'International', 'Vanguard Developed Mkts ETF', { fund: true, vol: 0.16 }),
  EEM:  T('equity', 'Emerging Markets', 'MSCI Emerging Mkts ETF', { fund: true, vol: 0.20 }),
  VWO:  T('equity', 'Emerging Markets', 'Vanguard Emerging Mkts ETF', { fund: true, vol: 0.20 }),
  SCHD: T('equity', 'Dividend', 'Schwab US Dividend ETF', { fund: true, vol: 0.15 }),
  VYM:  T('equity', 'Dividend', 'Vanguard High Dividend ETF', { fund: true, vol: 0.15 }),
  XLK:  T('equity', 'Technology', 'Tech Select SPDR', { fund: true, vol: 0.24 }),
  XLF:  T('equity', 'Financials', 'Financials Select SPDR', { fund: true, vol: 0.20 }),
  XLE:  T('equity', 'Energy', 'Energy Select SPDR', { fund: true, vol: 0.25 }),
  XLV:  T('equity', 'Health Care', 'Health Care Select SPDR', { fund: true, vol: 0.15 }),
  XLU:  T('equity', 'Utilities', 'Utilities Select SPDR', { fund: true, vol: 0.16 }),
  ARKK: T('equity', 'Technology', 'ARK Innovation ETF', { fund: true, vol: 0.50, spec: true }),
  SMH:  T('equity', 'Technology', 'Semiconductor ETF', { fund: true, vol: 0.32 }),
  // ---- Bonds
  BND:  T('bond', 'Aggregate Bonds', 'Vanguard Total Bond ETF', { fund: true, vol: 0.06, duration: 6 }),
  AGG:  T('bond', 'Aggregate Bonds', 'iShares Core US Aggregate', { fund: true, vol: 0.06, duration: 6 }),
  TLT:  T('bond', 'Long Treasuries', 'iShares 20+Y Treasury', { fund: true, vol: 0.15, duration: 16.5 }),
  IEF:  T('bond', 'Intermediate Treasuries', 'iShares 7-10Y Treasury', { fund: true, vol: 0.07, duration: 7.5 }),
  SHY:  T('bond', 'Short Treasuries', 'iShares 1-3Y Treasury', { fund: true, vol: 0.02, duration: 1.9 }),
  BIL:  T('cash', 'T-Bills', 'SPDR 1-3M T-Bill ETF', { fund: true, vol: 0.005, duration: 0.1 }),
  SGOV: T('cash', 'T-Bills', 'iShares 0-3M Treasury', { fund: true, vol: 0.005, duration: 0.1 }),
  TIP:  T('bond', 'TIPS', 'iShares TIPS Bond ETF', { fund: true, vol: 0.06, duration: 6.5 }),
  LQD:  T('bond', 'IG Corporate', 'iShares IG Corporate', { fund: true, vol: 0.09, duration: 8.5 }),
  HYG:  T('bond', 'High Yield', 'iShares High Yield Corporate', { fund: true, vol: 0.08, duration: 3.5 }),
  JNK:  T('bond', 'High Yield', 'SPDR High Yield', { fund: true, vol: 0.08, duration: 3.5 }),
  MUB:  T('bond', 'Municipal', 'iShares National Muni', { fund: true, vol: 0.05, duration: 6 }),
  BNDX: T('bond', 'International Bonds', 'Vanguard Total Intl Bond', { fund: true, vol: 0.05, duration: 7 }),
  // ---- Commodities
  GLD:  T('commodity', 'Gold', 'SPDR Gold Shares', { fund: true, vol: 0.15 }),
  IAU:  T('commodity', 'Gold', 'iShares Gold Trust', { fund: true, vol: 0.15 }),
  SLV:  T('commodity', 'Silver', 'iShares Silver Trust', { fund: true, vol: 0.28 }),
  USO:  T('commodity', 'Oil', 'United States Oil Fund', { fund: true, vol: 0.38 }),
  DBC:  T('commodity', 'Broad Commodities', 'Invesco DB Commodity', { fund: true, vol: 0.20 }),
  PDBC: T('commodity', 'Broad Commodities', 'Invesco Optimum Yield Commodity', { fund: true, vol: 0.20 }),
  // ---- Real estate
  VNQ:  T('realestate', 'REITs', 'Vanguard Real Estate ETF', { fund: true, vol: 0.21 }),
  XLRE: T('realestate', 'REITs', 'Real Estate Select SPDR', { fund: true, vol: 0.21 }),
  O:    T('realestate', 'REITs', 'Realty Income', { vol: 0.20 }),
  PLD:  T('realestate', 'REITs', 'Prologis', { vol: 0.28 }),
  AMT:  T('realestate', 'REITs', 'American Tower', { vol: 0.27 }),
  SPG:  T('realestate', 'REITs', 'Simon Property Group', { vol: 0.30 }),
  // ---- Crypto (spot and ETFs)
  BTC:  T('crypto', 'Crypto', 'Bitcoin', { vol: 0.55, spec: true, yahoo: 'BTC-USD' }),
  ETH:  T('crypto', 'Crypto', 'Ethereum', { vol: 0.70, spec: true, yahoo: 'ETH-USD' }),
  SOL:  T('crypto', 'Crypto', 'Solana', { vol: 0.90, spec: true, yahoo: 'SOL-USD' }),
  DOGE: T('crypto', 'Crypto', 'Dogecoin', { vol: 1.00, spec: true, yahoo: 'DOGE-USD' }),
  IBIT: T('crypto', 'Crypto', 'iShares Bitcoin Trust', { fund: true, vol: 0.55, spec: true }),
  FBTC: T('crypto', 'Crypto', 'Fidelity Wise Origin Bitcoin', { fund: true, vol: 0.55, spec: true }),
  GBTC: T('crypto', 'Crypto', 'Grayscale Bitcoin Trust', { fund: true, vol: 0.55, spec: true }),
  ETHA: T('crypto', 'Crypto', 'iShares Ethereum Trust', { fund: true, vol: 0.70, spec: true }),
  MSTR: T('equity', 'Crypto', 'Strategy (MicroStrategy)', { vol: 0.85, spec: true }),
  // ---- Meme / speculative
  GME:  T('equity', 'Consumer Discretionary', 'GameStop', { vol: 0.90, spec: true }),
  AMC:  T('equity', 'Communication Services', 'AMC Entertainment', { vol: 1.00, spec: true }),
}

const CASH_ALIASES = new Set(['CASH', 'USD', '$', 'MMF', 'SPAXX', 'VMFXX', 'SWVXX', 'FDRXX'])

/** Default annualised vol when we only know the class/sector. */
const CLASS_VOL = {
  equity: 0.28, bond: 0.07, cash: 0.0, crypto: 0.70, commodity: 0.20, realestate: 0.22,
}
const SECTOR_VOL = { Technology: 0.32, 'Broad Market': 0.17, Utilities: 0.17, 'Consumer Staples': 0.16 }

export function classify(rawTicker) {
  const ticker = String(rawTicker).toUpperCase().replace(/-USD$/, '')
  if (CASH_ALIASES.has(ticker)) {
    return { ticker: 'CASH', cls: 'cash', sector: 'Cash', name: 'Cash & equivalents', fund: true, vol: 0, known: true, duration: 0 }
  }
  const hit = MAP[ticker]
  if (hit) {
    const vol = hit.vol ?? SECTOR_VOL[hit.sector] ?? CLASS_VOL[hit.cls] ?? 0.28
    return { ticker, known: true, fund: !!hit.fund, spec: !!hit.spec, duration: hit.duration ?? 0, ...hit, vol }
  }
  return {
    ticker, cls: 'equity', sector: 'Unclassified', name: ticker, known: false,
    fund: false, spec: false, vol: CLASS_VOL.equity, duration: 0,
  }
}

/** Yahoo Finance symbol for market-data lookups. */
export function yahooSymbol(ticker) {
  const hit = MAP[ticker]
  if (hit?.yahoo) return hit.yahoo
  if (ticker === 'BRK.B' || ticker === 'BRKB') return 'BRK-B'
  return ticker
}

/** Equity-market beta used in the shock scenario (rough, by class/sector). */
export function equityBeta(c) {
  if (c.cls === 'cash') return 0
  if (c.cls === 'bond') return c.sector === 'High Yield' ? 0.35 : (c.duration > 10 ? -0.25 : -0.1)
  if (c.cls === 'commodity') return c.sector === 'Gold' ? 0.0 : 0.4
  if (c.cls === 'crypto') return 1.8
  if (c.cls === 'realestate') return 1.0
  if (c.spec) return 1.8
  const bySector = {
    Technology: 1.25, 'Communication Services': 1.1, 'Consumer Discretionary': 1.2, Financials: 1.1,
    'Health Care': 0.75, 'Consumer Staples': 0.6, Utilities: 0.55, Energy: 0.9, Industrials: 1.05,
    'Broad Market': 1.0, 'Small Cap': 1.2, International: 0.85, 'Emerging Markets': 1.0, Dividend: 0.8,
    Crypto: 1.8,
  }
  return bySector[c.sector] ?? 1.0
}

/** % price move for a +100bp parallel rate shock (rough). */
export function rateShock(c) {
  if (c.cls === 'cash') return 0
  if (c.cls === 'bond') return -(c.duration || 6)
  if (c.cls === 'realestate') return -6
  if (c.cls === 'crypto') return -6
  if (c.cls === 'commodity') return c.sector === 'Gold' ? -2 : 0
  const bySector = { Technology: -5, 'Communication Services': -4, Utilities: -4, 'Consumer Discretionary': -3, Financials: 1, Energy: 0 }
  return bySector[c.sector] ?? -2.5
}

/** Correlation group used for the constant-correlation fallback model. */
export function corrGroup(c) {
  if (c.cls === 'equity' || c.cls === 'realestate') return 'EQ'
  if (c.cls === 'bond') return 'BD'
  if (c.cls === 'commodity') return 'CM'
  if (c.cls === 'crypto') return 'CR'
  return 'CA'
}

const RHO = {
  'EQ|EQ': 0.65, 'EQ|BD': -0.1, 'EQ|CM': 0.15, 'EQ|CR': 0.4, 'EQ|CA': 0,
  'BD|BD': 0.8, 'BD|CM': 0.1, 'BD|CR': 0.0, 'BD|CA': 0,
  'CM|CM': 0.4, 'CM|CR': 0.2, 'CM|CA': 0,
  'CR|CR': 0.8, 'CR|CA': 0, 'CA|CA': 0,
}

export function assumedCorrelation(a, b) {
  if (a.ticker === b.ticker) return 1
  const ga = corrGroup(a), gb = corrGroup(b)
  if (ga === 'EQ' && gb === 'EQ' && a.sector === b.sector && a.sector !== 'Unclassified') return 0.8
  return RHO[`${ga}|${gb}`] ?? RHO[`${gb}|${ga}`] ?? 0.3
}
