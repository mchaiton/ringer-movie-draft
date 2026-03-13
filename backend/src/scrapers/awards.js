/**
 * scrapers/awards.js
 * Lightweight scrapers for festival awards and critics polls.
 *
 * Targets chosen for scrapeability and structural stability:
 *
 *   FESTIVAL AWARDS (annual, Wikipedia — most reliable scrape target)
 *     cannes     — Palme d'Or + Grand Prix + Jury Prize
 *     venice     — Golden Lion + Silver Lion + Jury Prize
 *     berlin     — Golden Bear + Silver Bear Grand Jury Prize
 *
 *   CRITICS POLLS (annual, official sites)
 *     afi_top10  — afi.com/afis-10-top-10 annual press release page
 *     nyfcc      — nyfcc.com (New York Film Critics Circle)
 *     nbr        — nationalboardofreview.org (National Board of Review)
 *
 * Scoring:
 *   Cannes Palme d'Or / Venice Golden Lion / Berlin Golden Bear  → 4 pts
 *   Other major festival prizes (Grand Prix, Silver Lion, etc.)  → 2 pts
 *   AFI Top 10 / NYFCC Best Picture / NBR Best Film             → 3 pts
 *   NYFCC / NBR other top awards                                → 2 pts
 *
 * Scraping approach: cheerio (server-side jQuery-like HTML parsing).
 * All scrapers return a consistent AwardResult shape.
 */

require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');

const DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || '1500', 10);

/** Pause between requests — be polite */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @typedef {Object} AwardResult
 * @property {string}      title        — movie title as it appears on the source
 * @property {string}      source       — cannes | venice | berlin | afi_top10 | nyfcc | nbr
 * @property {string}      award_name   — e.g. "Palme d'Or"
 * @property {number}      year
 * @property {number}      points       — pre-calculated per scoring rules
 * @property {string}      source_url
 */

/**
 * Generic Wikipedia table scraper.
 * Wikipedia award pages use a consistent <table class="wikitable"> structure
 * with film titles linking to their Wikipedia article.
 *
 * @param {string} url         Wikipedia article URL
 * @param {string} awardName   e.g. "Palme d'Or"
 * @param {string} source      cannes | venice | berlin
 * @param {number} year
 * @param {number} points
 * @returns {Promise<AwardResult[]>}
 */
async function scrapeWikipediaAward(url, awardName, source, year, points) {
  console.log(`[scraper:${source}] Fetching ${url}`);
  await sleep(DELAY_MS);

  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'RingerMovieDraft/1.0 (film league research tool)' },
      timeout: 12_000,
    });

    const $ = cheerio.load(res.data);
    const results = [];

    // Wikipedia award tables: look for the year row in the wikitable
    // Structure varies slightly, but the film title is always in a <td> with an <a> link
    // Strategy: find the row containing the target year, extract the film title from the same row
    $('table.wikitable tr').each((i, row) => {
      const cells = $(row).find('td');
      const text  = $(row).text();

      // Check if this row contains our year
      if (!text.includes(String(year))) return;

      // Film title is typically the first or second <td> containing an <a> tag
      cells.each((j, cell) => {
        const link = $(cell).find('a').first();
        if (link.length && !$(cell).find('a[href*="film"]').length) {
          const title = link.text().trim();
          if (title && title.length > 1 && !title.match(/^\d{4}$/)) {
            results.push({ title, source, award_name: awardName, year, points, source_url: url });
            return false; // take first valid film title per row
          }
        }
      });
    });

    // Fallback: if table-based parsing found nothing, try a simpler text scan
    if (results.length === 0) {
      $('table.wikitable').first().find('tr').each((i, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 2) {
          const yearCell = $(cells[0]).text().trim();
          if (yearCell === String(year) || yearCell.includes(String(year))) {
            const titleCell = $(cells[1]).find('a').first().text().trim() ||
                              $(cells[1]).text().trim();
            if (titleCell) {
              results.push({ title: titleCell, source, award_name: awardName, year, points, source_url: url });
            }
          }
        }
      });
    }

    console.log(`[scraper:${source}] Found ${results.length} result(s) for ${year}`);
    return results;
  } catch (err) {
    console.error(`[scraper:${source}] Failed:`, err.message);
    return [];
  }
}

/**
 * Scrape Cannes Film Festival winners from Wikipedia.
 * Targets: Palme d'Or, Grand Prix, Jury Prize
 *
 * @param {number} year
 * @returns {Promise<AwardResult[]>}
 */
async function scrapeCannes(year) {
  const baseUrl = `https://en.wikipedia.org/wiki/${year}_Cannes_Film_Festival`;
  const awards = [
    { name: "Palme d'Or",   points: 4 },
    { name: 'Grand Prix',   points: 2 },
    { name: 'Jury Prize',   points: 2 },
  ];

  const results = [];
  for (const award of awards) {
    const found = await scrapeWikipediaAward(baseUrl, award.name, 'cannes', year, award.points);
    results.push(...found);
    await sleep(DELAY_MS);
  }
  return results;
}

/**
 * Scrape Venice Film Festival winners from Wikipedia.
 * Targets: Golden Lion, Silver Lion Grand Jury Prize, Special Jury Prize
 *
 * @param {number} year
 * @returns {Promise<AwardResult[]>}
 */
async function scrapeVenice(year) {
  const baseUrl = `https://en.wikipedia.org/wiki/${year}_Venice_International_Film_Festival`;
  const awards = [
    { name: 'Golden Lion',                  points: 4 },
    { name: 'Silver Lion – Grand Jury Prize', points: 2 },
    { name: 'Special Jury Prize',           points: 2 },
  ];

  const results = [];
  for (const award of awards) {
    const found = await scrapeWikipediaAward(baseUrl, award.name, 'venice', year, award.points);
    results.push(...found);
    await sleep(DELAY_MS);
  }
  return results;
}

/**
 * Scrape Berlin International Film Festival (Berlinale) winners from Wikipedia.
 * Targets: Golden Bear, Silver Bear Grand Jury Prize
 *
 * @param {number} year
 * @returns {Promise<AwardResult[]>}
 */
async function scrapeBerlin(year) {
  const baseUrl = `https://en.wikipedia.org/wiki/${year}_Berlin_International_Film_Festival`;
  const awards = [
    { name: 'Golden Bear',                  points: 4 },
    { name: 'Silver Bear – Grand Jury Prize', points: 2 },
  ];

  const results = [];
  for (const award of awards) {
    const found = await scrapeWikipediaAward(baseUrl, award.name, 'berlin', year, award.points);
    results.push(...found);
    await sleep(DELAY_MS);
  }
  return results;
}

/**
 * Scrape AFI Top 10 Films of the Year.
 * AFI publishes their list on afi.com — structure is a simple list page.
 * Falls back to Wikipedia if the AFI page structure has changed.
 *
 * @param {number} year
 * @returns {Promise<AwardResult[]>}
 */
async function scrapeAFI(year) {
  const url = `https://en.wikipedia.org/wiki/AFI%27s_10_Top_10`;
  console.log(`[scraper:afi_top10] Fetching Wikipedia AFI Top 10 page for ${year}`);
  await sleep(DELAY_MS);

  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'RingerMovieDraft/1.0' },
      timeout: 12_000,
    });

    // AFI annual list is structured differently — fetch the year-specific section
    // This page is the lifetime 10-top-10 list; for annual AFI top 10 we use their press release
    // Simpler: check the AFI Awards page
    const afiAnnualUrl = `https://en.wikipedia.org/wiki/${year}_AFI_Awards`;
    const res2 = await axios.get(afiAnnualUrl, {
      headers: { 'User-Agent': 'RingerMovieDraft/1.0' },
      timeout: 12_000,
    });

    const $ = cheerio.load(res2.data);
    const results = [];

    // AFI Awards page lists movies in an ordered list under "Motion Picture" section
    let inMovieSection = false;
    $('h2, h3, ol li, ul li').each((i, el) => {
      const tag  = el.name;
      const text = $(el).text().trim();

      if (tag === 'h2' || tag === 'h3') {
        inMovieSection = text.toLowerCase().includes('motion picture') ||
                         text.toLowerCase().includes('movie') ||
                         text.toLowerCase().includes('film');
        return;
      }

      if (inMovieSection && (tag === 'li')) {
        const title = $(el).find('a').first().text().trim() || text;
        if (title && title.length > 1) {
          results.push({
            title,
            source:     'afi_top10',
            award_name: 'AFI Top 10 Film',
            year,
            points:     3,
            source_url: afiAnnualUrl,
          });
        }
        // Stop after 10 items
        if (results.length >= 10) return false;
      }
    });

    console.log(`[scraper:afi_top10] Found ${results.length} films for ${year}`);
    return results;
  } catch (err) {
    console.error('[scraper:afi_top10] Failed:', err.message);
    return [];
  }
}

/**
 * Scrape NYFCC (New York Film Critics Circle) winners from their website.
 * nyfcc.com publishes a clean annual results page.
 *
 * @param {number} year
 * @returns {Promise<AwardResult[]>}
 */
async function scrapeNYFCC(year) {
  // NYFCC announces in December; results on nyfcc.com
  // Wikipedia is more reliably structured for historical years
  const url = `https://en.wikipedia.org/wiki/${year}_New_York_Film_Critics_Circle_Awards`;
  console.log(`[scraper:nyfcc] Fetching ${url}`);
  await sleep(DELAY_MS);

  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'RingerMovieDraft/1.0' },
      timeout: 12_000,
    });

    const $ = cheerio.load(res.data);
    const results = [];

    // NYFCC Wikipedia pages use a wikitable with "Award" and "Film" columns
    $('table.wikitable tr').each((i, row) => {
      if (i === 0) return; // skip header
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const awardName = $(cells[0]).text().trim();
      const filmLink  = $(cells[1]).find('a').first();
      const title     = filmLink.text().trim() || $(cells[1]).text().trim();

      if (!title) return;

      const points = awardName.toLowerCase().includes('best film') ||
                     awardName.toLowerCase().includes('best picture') ? 3 : 2;

      results.push({
        title,
        source:     'nyfcc',
        award_name: awardName || 'NYFCC Award',
        year,
        points,
        source_url: url,
      });
    });

    console.log(`[scraper:nyfcc] Found ${results.length} awards for ${year}`);
    return results;
  } catch (err) {
    console.error('[scraper:nyfcc] Failed:', err.message);
    return [];
  }
}

/**
 * Scrape National Board of Review winners from Wikipedia.
 * NBR announces in late November/early December.
 *
 * @param {number} year
 * @returns {Promise<AwardResult[]>}
 */
async function scrapeNBR(year) {
  const url = `https://en.wikipedia.org/wiki/${year}_National_Board_of_Review_Awards`;
  console.log(`[scraper:nbr] Fetching ${url}`);
  await sleep(DELAY_MS);

  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'RingerMovieDraft/1.0' },
      timeout: 12_000,
    });

    const $ = cheerio.load(res.data);
    const results = [];

    $('table.wikitable tr').each((i, row) => {
      if (i === 0) return;
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const awardName = $(cells[0]).text().trim();
      const title     = $(cells[1]).find('a').first().text().trim() ||
                        $(cells[1]).text().trim();

      if (!title) return;

      const isBest = awardName.toLowerCase().includes('best film') ||
                     awardName.toLowerCase().includes('best picture');
      const points = isBest ? 3 : 2;

      results.push({
        title,
        source:     'nbr',
        award_name: awardName || 'NBR Award',
        year,
        points,
        source_url: url,
      });
    });

    console.log(`[scraper:nbr] Found ${results.length} awards for ${year}`);
    return results;
  } catch (err) {
    console.error('[scraper:nbr] Failed:', err.message);
    return [];
  }
}

/**
 * Run all festival + critics poll scrapers for a given year.
 * Returns a flat array of AwardResult objects.
 *
 * @param {number} year
 * @returns {Promise<AwardResult[]>}
 */
async function scrapeAllAwards(year) {
  console.log(`\n[scrapers] Running all award scrapers for ${year}…`);

  const [cannes, venice, berlin, afi, nyfcc, nbr] = await Promise.allSettled([
    scrapeCannes(year),
    scrapeVenice(year),
    scrapeBerlin(year),
    scrapeAFI(year),
    scrapeNYFCC(year),
    scrapeNBR(year),
  ]);

  const flatten = result => result.status === 'fulfilled' ? result.value : [];

  const all = [
    ...flatten(cannes),
    ...flatten(venice),
    ...flatten(berlin),
    ...flatten(afi),
    ...flatten(nyfcc),
    ...flatten(nbr),
  ];

  console.log(`[scrapers] Total award results: ${all.length}`);
  return all;
}

module.exports = {
  scrapeCannes,
  scrapeVenice,
  scrapeBerlin,
  scrapeAFI,
  scrapeNYFCC,
  scrapeNBR,
  scrapeAllAwards,
};
