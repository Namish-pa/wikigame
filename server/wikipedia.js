const axios = require('axios');
const cheerio = require('cheerio');

// In-memory cache for article html and links
const articleCache = new Map();

// In-memory cache for challenge pairs to avoid re-validating during the same game
const validChallengesCache = [];

/**
 * Normalizes a Wikipedia title (replaces spaces with underscores and decodes)
 */
function normalizeTitle(title) {
  if (!title) return '';
  let t = title.trim();
  try {
    t = decodeURIComponent(t);
  } catch (e) {
    // Keep original if decoding fails
  }
  return t.replace(/ /g, '_');
}

/**
 * Fetches article content from Wikipedia, cleans it, and extracts valid outgoing links.
 * Cache results to avoid hitting the API repeatedly.
 */
async function fetchArticle(title) {
  const normTitle = normalizeTitle(title);
  if (articleCache.has(normTitle)) {
    return articleCache.get(normTitle);
  }

  try {
    const url = `https://en.wikipedia.org/w/api.php`;
    const response = await axios.get(url, {
      params: {
        action: 'parse',
        page: normTitle,
        format: 'json',
        prop: 'text|displaytitle',
        redirects: 1,
        disablelimitreport: 1,
        disableeditsection: 1,
        usetoc: 0
      },
      headers: {
        'User-Agent': 'WikipediaRaceGame/1.0 (contact: game-developer@example.com)'
      }
    });

    if (response.data.error) {
      throw new Error(response.data.error.info || 'Failed to parse page');
    }

    const parseData = response.data.parse;
    const canonicalTitle = normalizeTitle(parseData.title);
    const htmlContent = parseData.text['*'];

    // Parse and clean HTML using Cheerio
    const $ = cheerio.load(htmlContent);

    // Remove noise elements
    $(
      '.navbox, .reflist, .reference, .mw-editsection, .portal, .authority-control, ' +
      '.catlinks, #mw-navigation, #mw-page-base, #mw-head-base, .sidebar, ' +
      '.ambox, .sistersitebox, .sitelist, .infobox.navigation, .hatnote, .metadata'
    ).remove();

    // Extract and rewrite links
    const links = new Set();
    $('a').each((i, el) => {
      const $el = $(el);
      const href = $el.attr('href');

      if (href && href.startsWith('/wiki/')) {
        // Exclude special namespaces (Category, Special, File, Wikipedia, Help, Template, Talk, etc.)
        const linkTitle = href.substring(6); // Remove '/wiki/'
        const decodedLinkTitle = normalizeTitle(linkTitle);

        const isNamespace = decodedLinkTitle.includes(':') || 
                            decodedLinkTitle.startsWith('Main_Page');

        if (!isNamespace) {
          links.add(decodedLinkTitle);
          // Rewrite href to prevent standard page navigations
          $el.attr('href', 'javascript:void(0)');
          $el.attr('data-wiki-link', decodedLinkTitle);
          // Remove target attribute to prevent opening in a new tab
          $el.removeAttr('target');
        } else {
          // Remove non-article links entirely or strip href
          $el.replaceWith($el.text());
        }
      } else {
        // Remove external links or references
        $el.replaceWith($el.text());
      }
    });

    // Cleaned HTML representation
    const cleanedHtml = $.html();
    const result = {
      title: canonicalTitle,
      html: cleanedHtml,
      links: Array.from(links)
    };

    // Store in cache under both original searched title and canonical title
    articleCache.set(normTitle, result);
    articleCache.set(canonicalTitle, result);

    return result;
  } catch (err) {
    console.error(`Error fetching Wikipedia article "${title}":`, err.message);
    throw err;
  }
}

/**
 * Fetches outgoing links of a page using the Wikipedia Query API
 */
async function getOutgoingLinks(title) {
  try {
    const url = `https://en.wikipedia.org/w/api.php`;
    const response = await axios.get(url, {
      params: {
        action: 'query',
        titles: title,
        prop: 'links',
        plnamespace: 0,
        pllimit: 500,
        redirects: 1,
        format: 'json'
      },
      headers: {
        'User-Agent': 'WikipediaRaceGame/1.0 (contact: game-developer@example.com)'
      }
    });

    const pages = response.data.query?.pages;
    if (!pages) return [];

    const pageId = Object.keys(pages)[0];
    if (pageId === '-1' || !pages[pageId].links) return [];

    return pages[pageId].links.map(l => normalizeTitle(l.title));
  } catch (err) {
    console.error(`Error getting outgoing links for "${title}":`, err.message);
    return [];
  }
}

/**
 * Fetches backlinks (incoming links) of a page using the Wikipedia Query API
 */
async function getIncomingLinks(title) {
  try {
    const url = `https://en.wikipedia.org/w/api.php`;
    const response = await axios.get(url, {
      params: {
        action: 'query',
        list: 'backlinks',
        bltitle: title,
        blnamespace: 0,
        bllimit: 500,
        redirects: 1,
        format: 'json'
      },
      headers: {
        'User-Agent': 'WikipediaRaceGame/1.0 (contact: game-developer@example.com)'
      }
    });

    const backlinks = response.data.query?.backlinks;
    if (!backlinks) return [];

    return backlinks.map(bl => normalizeTitle(bl.title));
  } catch (err) {
    console.error(`Error getting incoming links for "${title}":`, err.message);
    return [];
  }
}

/**
 * Validates whether a valid 2-hop path exists between start and target,
 * and ensures they are not trivially directly connected.
 */
async function validateChallenge(start, target) {
  if (start === target) return false;

  const startOut = await getOutgoingLinks(start);
  if (startOut.length === 0) return false;

  // If start directly links to target, it is a 1-click trivial challenge. Reject it!
  if (startOut.includes(target)) {
    return false;
  }

  const targetIn = await getIncomingLinks(target);
  if (targetIn.length === 0) return false;

  // Find intersection: startOut links that link to targetIn
  const intersection = startOut.filter(link => targetIn.includes(link));

  // If there is at least one intersection, a 2-click path exists!
  return intersection.length > 0;
}

/**
 * Generates a validated challenge. If validation fails, it retries.
 */
async function generateChallenge(seedList) {
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    attempts++;
    const startIdx = Math.floor(Math.random() * seedList.length);
    let targetIdx = Math.floor(Math.random() * seedList.length);

    while (startIdx === targetIdx) {
      targetIdx = Math.floor(Math.random() * seedList.length);
    }

    const start = normalizeTitle(seedList[startIdx]);
    const target = normalizeTitle(seedList[targetIdx]);

    // Check if we already have this valid pair cached
    const cachedPair = validChallengesCache.find(p => p.start === start && p.target === target);
    if (cachedPair) {
      return cachedPair;
    }

    console.log(`Validating challenge (Attempt ${attempts}): ${start} -> ${target}`);
    const isValid = await validateChallenge(start, target);

    if (isValid) {
      const challenge = { start, target };
      validChallengesCache.push(challenge);
      return challenge;
    }
  }

  // Fallback if no 2-hop path found: pick two highly recognizable hubs
  console.log("Fallback challenge generation...");
  return {
    start: normalizeTitle("Albert_Einstein"),
    target: normalizeTitle("Theory_of_Relativity")
  };
}

module.exports = {
  fetchArticle,
  generateChallenge,
  normalizeTitle,
  validateChallenge
};
