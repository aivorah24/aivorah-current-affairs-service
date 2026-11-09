// Approved sources only (PRD §6.1). The pipeline never searches the open web:
// it reads these feeds, and keeps an item only if its link is on the source's
// own allowed hosts.
//
// enabled: false = approved, but no public feed we can use yet (Reuters and AP
// need a licensed API; others have no RSS). Add the URL and flip it on once
// one is available. Every enabled URL returned RSS to this script on 2026-11-09.
//
// credibility: 3 = official/primary body, 2 = established newsroom or journal.
const SOURCES = [
  // India
  { id: 'pib', name: 'PIB (Press Information Bureau)', category: 'india', credibility: 3, enabled: false,
    url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3', allowedHosts: ['pib.gov.in'],
    note: 'Answers 403 to an automated (bot) user agent, and otherwise redirects to the Hindi feed — ask PIB for feed access' },
  { id: 'the-hindu', name: 'The Hindu', category: 'india', credibility: 2, enabled: true,
    url: 'https://www.thehindu.com/news/national/feeder/default.rss', allowedHosts: ['thehindu.com'] },
  { id: 'indian-express', name: 'The Indian Express', category: 'india', credibility: 2, enabled: true,
    url: 'https://indianexpress.com/section/india/feed/', allowedHosts: ['indianexpress.com'] },

  // World
  { id: 'bbc-world', name: 'BBC News', category: 'world', credibility: 2, enabled: true,
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml', allowedHosts: ['bbc.co.uk', 'bbc.com'] },
  { id: 'reuters', name: 'Reuters', category: 'world', credibility: 2, enabled: false,
    url: '', allowedHosts: ['reuters.com'], note: 'No public RSS since 2020 — needs a Reuters Connect licence/API key' },
  { id: 'ap', name: 'Associated Press', category: 'world', credibility: 2, enabled: false,
    url: '', allowedHosts: ['apnews.com'], note: 'No public RSS — needs the AP Media API' },

  // Economy
  { id: 'rbi', name: 'Reserve Bank of India', category: 'economy', credibility: 3, enabled: true,
    url: 'https://www.rbi.org.in/pressreleases_rss.xml', allowedHosts: ['rbi.org.in'] },
  { id: 'world-bank', name: 'World Bank', category: 'economy', credibility: 3, enabled: false,
    url: '', allowedHosts: ['worldbank.org'], note: 'No working public RSS found' },
  { id: 'imf', name: 'IMF', category: 'economy', credibility: 3, enabled: false,
    url: '', allowedHosts: ['imf.org'], note: 'RSS endpoint blocks automated clients (403)' },

  // Science & Tech
  { id: 'nasa', name: 'NASA', category: 'science', credibility: 3, enabled: true,
    url: 'https://www.nasa.gov/news-release/feed/', allowedHosts: ['nasa.gov'] },
  { id: 'nature', name: 'Nature', category: 'science', credibility: 2, enabled: false,
    url: 'https://www.nature.com/nature.rss', allowedHosts: ['nature.com'],
    note: 'Feed redirects through a browser sign-in handshake that scripts cannot complete' },
  { id: 'isro', name: 'ISRO', category: 'science', credibility: 3, enabled: false,
    url: '', allowedHosts: ['isro.gov.in'], note: 'No public RSS — ISRO news reaches the pipeline through PIB' },

  // Environment
  { id: 'unep', name: 'UNEP', category: 'environment', credibility: 3, enabled: false,
    url: '', allowedHosts: ['unep.org'], note: 'No working public RSS found' },
  { id: 'ipcc', name: 'IPCC', category: 'environment', credibility: 3, enabled: false,
    url: '', allowedHosts: ['ipcc.ch'], note: 'No public RSS' },
  { id: 'un-news-climate', name: 'UN News — Climate', category: 'environment', credibility: 3, enabled: false,
    url: 'https://news.un.org/feed/subscribe/en/news/topic/climate-change/feed/rss.xml', allowedHosts: ['news.un.org'],
    note: 'Working feed, but UN News is not on the PRD source list — enable once approved' },

  // Society & Culture (health, education)
  // Feed works but is rarely updated (latest item was a month old on 2026-11-09).
  { id: 'who', name: 'World Health Organization', category: 'society', credibility: 3, enabled: true,
    url: 'https://www.who.int/rss-feeds/news-english.xml', allowedHosts: ['who.int'] },
  { id: 'unesco', name: 'UNESCO', category: 'society', credibility: 3, enabled: false,
    url: '', allowedHosts: ['unesco.org'], note: 'No working public RSS found' },
  { id: 'unicef', name: 'UNICEF', category: 'society', credibility: 3, enabled: false,
    url: '', allowedHosts: ['unicef.org'], note: 'No public RSS found' },

  // Sports
  { id: 'sports-federations', name: 'Official sports federations', category: 'sports', credibility: 3, enabled: false,
    url: '', allowedHosts: ['olympics.com', 'bcci.tv', 'the-aiff.com', 'fifa.com', 'icc-cricket.com'],
    note: 'Federations publish no usable RSS — add official feeds/APIs here' },
];

function enabledSources(list = SOURCES) {
  return list.filter((s) => s.enabled && s.url);
}

module.exports = { SOURCES, enabledSources };
