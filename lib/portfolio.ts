// The mock portfolio. Chosen for spread: mega-cap banks & IT, PSU, defence,
// consumer, auto, pharma, new-age internet, and mid-cap manufacturing.
// BSE codes verified against screener.in (Oct 2026).

export type Holding = {
  symbol: string; // NSE symbol
  bse: string; // BSE scrip code
  name: string;
  sector: string;
  isBank?: boolean; // banks/NBFCs report NII instead of EBITDA
};

export const PORTFOLIO: Holding[] = [
  { symbol: "HDFCBANK", bse: "500180", name: "HDFC Bank", sector: "Banks", isBank: true },
  { symbol: "ICICIBANK", bse: "532174", name: "ICICI Bank", sector: "Banks", isBank: true },
  { symbol: "BAJFINANCE", bse: "500034", name: "Bajaj Finance", sector: "NBFC", isBank: true },
  { symbol: "RELIANCE", bse: "500325", name: "Reliance Industries", sector: "Conglomerate" },
  { symbol: "TCS", bse: "532540", name: "Tata Consultancy Services", sector: "IT services" },
  { symbol: "INFY", bse: "500209", name: "Infosys", sector: "IT services" },
  { symbol: "KPITTECH", bse: "542651", name: "KPIT Technologies", sector: "IT services" },
  { symbol: "BHARTIARTL", bse: "532454", name: "Bharti Airtel", sector: "Telecom" },
  { symbol: "ITC", bse: "500875", name: "ITC", sector: "FMCG" },
  { symbol: "DMART", bse: "540376", name: "Avenue Supermarts", sector: "Retail" },
  { symbol: "TITAN", bse: "500114", name: "Titan Company", sector: "Consumer" },
  { symbol: "MARUTI", bse: "532500", name: "Maruti Suzuki", sector: "Auto" },
  { symbol: "M&M", bse: "500520", name: "Mahindra & Mahindra", sector: "Auto" },
  { symbol: "SUNPHARMA", bse: "524715", name: "Sun Pharma", sector: "Pharma" },
  { symbol: "LT", bse: "500510", name: "Larsen & Toubro", sector: "Capital goods" },
  { symbol: "HAL", bse: "541154", name: "Hindustan Aeronautics", sector: "Defence" },
  { symbol: "COALINDIA", bse: "533278", name: "Coal India", sector: "Mining (PSU)" },
  { symbol: "ETERNAL", bse: "543320", name: "Eternal (Zomato)", sector: "Internet" },
  { symbol: "DIXON", bse: "540699", name: "Dixon Technologies", sector: "Electronics mfg" },
  { symbol: "POLYCAB", bse: "542652", name: "Polycab India", sector: "Cables & wires" },
];

// Companies outside the portfolio used to demo on-demand research.
// The engine is not limited to these — any NSE symbol on screener.in works.
export const RESEARCH_DEMO = ["ASIANPAINT", "PAYTM", "KAYNES", "IDEAFORGE"];

export const yahooSymbol = (nse: string) => `${nse}.NS`;
