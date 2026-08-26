// Generates neofetch-style dark_mode.svg / light_mode.svg profile cards.
// Requires ACCESS_TOKEN env var: a PAT with `repo` + `read:user` scope, owned by USERNAME.
// The ASCII art block (ART, from photo-to-ascii.mjs) is static and committed —
// only the GitHub stats are recomputed here, daily, by the Action.
// Layout/typography mirrors https://github.com/Andrew6rant/Andrew6rant (single
// <text> per column, absolutely-positioned <tspan>s, dash-rule section headers).
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ART } from "./pixels.mjs";

const USERNAME = "danielcaze";
const TOKEN = process.env.ACCESS_TOKEN;
if (!TOKEN) throw new Error("ACCESS_TOKEN env var missing");

const gql = async (query, variables = {}) => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
};

// --- repos, stars ---
async function getRepos() {
  let repos = [];
  let after = null;
  while (true) {
    const data = await gql(
      `query($after: String) {
        viewer {
          repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false, privacy: null) {
            pageInfo { hasNextPage endCursor }
            nodes { name stargazerCount defaultBranchRef { name } }
          }
        }
      }`,
      { after }
    );
    const r = data.viewer.repositories;
    repos = repos.concat(r.nodes);
    if (!r.pageInfo.hasNextPage) break;
    after = r.pageInfo.endCursor;
  }
  return repos;
}

// --- follower count ---
async function getFollowers() {
  const data = await gql(`query { viewer { followers { totalCount } } }`);
  return data.viewer.followers.totalCount;
}

// --- repos contributed to (excluding own repos) ---
async function getContributed() {
  const data = await gql(
    `query {
      viewer {
        repositoriesContributedTo(first: 1, includeUserRepositories: false, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
          totalCount
        }
      }
    }`
  );
  return data.viewer.repositoriesContributedTo.totalCount;
}

// --- total commit contributions across account lifetime ---
async function getTotalCommits() {
  const meta = await gql(`query { viewer { createdAt } }`);
  const startYear = new Date(meta.viewer.createdAt).getFullYear();
  const endYear = new Date().getFullYear();
  let total = 0;
  for (let y = startYear; y <= endYear; y++) {
    const data = await gql(
      `query($from: DateTime!, $to: DateTime!) {
        viewer {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            restrictedContributionsCount
          }
        }
      }`,
      { from: `${y}-01-01T00:00:00Z`, to: `${y}-12-31T23:59:59Z` }
    );
    const c = data.viewer.contributionsCollection;
    total += c.totalCommitContributions + c.restrictedContributionsCount;
  }
  return total;
}

// --- lines of code added/deleted, summed via git log --numstat across owned repos ---
function getLoc(repos) {
  let additions = 0;
  let deletions = 0;
  const workdir = mkdtempSync(join(tmpdir(), "loc-"));
  for (const repo of repos) {
    const branch = repo.defaultBranchRef?.name;
    if (!branch) continue; // empty repo
    const dest = join(workdir, repo.name);
    try {
      execSync(
        `git clone --quiet --bare --single-branch --branch "${branch}" https://x-access-token:${TOKEN}@github.com/${USERNAME}/${repo.name}.git "${dest}"`,
        { stdio: "pipe" }
      );
      const out = execSync(`git --git-dir="${dest}" log --pretty=tformat: --numstat`, { stdio: "pipe" }).toString();
      for (const line of out.split("\n")) {
        const m = line.match(/^(\d+)\s+(\d+)\s+/);
        if (m) {
          additions += Number(m[1]);
          deletions += Number(m[2]);
        }
      }
    } catch {
      // skip repos we can't clone (e.g. empty, disabled)
    }
  }
  rmSync(workdir, { recursive: true, force: true });
  return { additions, deletions, net: additions - deletions };
}

const fmt = (n) => n.toLocaleString("en-US");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// prefix = ". " + label + ": " (before the dots)
const prefixLen = (label) => label.length + 4;
// dots computed per-row so every VALUE ends at the same right-hand column (rowChars),
// not so every value starts at the same left column — flex-end, not flex-start
const dots = (label, value, rowChars) => ".".repeat(Math.max(3, rowChars - prefixLen(label) - value.length));

// returns { svg, len } — len is the plain-text character count, used to size the card
function field(x, y, label, value, rowChars) {
  const d = dots(label, value, rowChars);
  const plain = `. ${label}: ${d} ${value}`;
  const svg = `<tspan x="${x}" y="${y}" class="cc">. </tspan><tspan class="key">${esc(label)}</tspan>:<tspan class="cc"> ${d} </tspan><tspan class="value">${esc(value)}</tspan>`;
  return { svg, len: plain.length };
}

// rule stretches so the whole header line lands on the same right edge (rowChars)
// as every field row below it — " -" + rule + "-—-" are the fixed non-rule chars
function header(x, y, text, rowChars) {
  // plain hyphens, not em dash: em dash renders wider than a monospace cell in
  // some SVG engines, which made the rule fall short of the field rows below it
  const fixed = " ---";
  const ruleWidth = Math.max(3, rowChars - text.length - fixed.length);
  const rule = "-".repeat(ruleWidth);
  const plain = `${text} -${rule}--`;
  const svg = `<tspan x="${x}" y="${y}">${esc(text)}</tspan> -${rule}--`;
  return { svg, len: plain.length };
}

function card({ repos, stars, commits, followers, contributed, loc, theme }) {
  // palette lifted from saara's src/renderer/src/theme.css
  const palettes = {
    dark: { bg: "#0a0a0a", fg: "#e8e8e8", key: "#d64545", value: "#e8e8e8", cc: "#6b6b6b", add: "#3fb950", del: "#f85149" },
    light: { bg: "#fafafa", fg: "#1a1a1a", key: "#991b1b", value: "#1a1a1a", cc: "#8a8a8a", add: "#1a7f37", del: "#cf222e" },
  };
  const p = palettes[theme];

  const fontSize = 16;
  const lineH = 20;
  // GitHub strips <style>/@font-face from embedded SVGs, so this always renders
  // with the viewer's generic fallback monospace, not Consolas — 0.6em is that
  // font's real advance width (0.52 undershot it, which clipped the right edge)
  const charW = fontSize * 0.6;
  const marginX = 15;
  const gap = 20; // clear visual break between the art column and the content column
  const ART_MAX_COLS = 36; // cap art width instead of growing the margin, so the
  // (fixed-size) SVG never has to squeeze the content column to make room
  const clippedArt = ART.map((l) => l.slice(0, ART_MAX_COLS));
  const artW = (ART_MAX_COLS + 2) * charW; // +2 chars safety margin
  const rightX = Math.round(marginX + artW + gap);

  const artTspans = clippedArt.map((line, i) => `<tspan x="${marginX}" y="${30 + i * lineH}">${esc(line)}</tspan>`).join("\n");

  const fields = [
    ["OS", "Windows 11"],
    ["Host", "Brazil (Remote)"],
    ["Kernel", "Software Engineer"],
    ["Uptime", "5+ years"],
    ["IDE", "VSCode"],
  ];
  const langFields = [
    ["Languages.Programming", "TypeScript, JavaScript, Go"],
    ["Frameworks.Frontend", "Next.js, Angular, React Native"],
    ["Frameworks.Backend", "NestJS"],
    ["Databases", "PostgreSQL, MySQL"],
    ["Infra", "Docker, AWS, Azure"],
    ["Languages.Real", "Portuguese, English"],
  ];
  const hobbies = [["Hobbies", "Surfing, Music, Exercise"]];
  const contact = [
    ["LinkedIn", "daniel-caze"],
    ["Email", "danielcazedev@gmail.com"],
  ];

  // one shared right-hand column for every single label:value row (right-aligned values)
  const allRows = [...fields, ...langFields, ...hobbies, ...contact];
  const rowChars = Math.max(...allRows.map(([l, v]) => prefixLen(l) + 3 + v.length));

  let y = 30;
  const lines = [];
  let maxLen = 0;
  const emit = (r) => {
    lines.push(r.svg);
    maxLen = Math.max(maxLen, r.len);
  };

  emit(header(rightX, y, "daniel@caze", rowChars));
  y += lineH;
  for (const [l, v] of fields) {
    emit(field(rightX, y, l, v, rowChars));
    y += lineH;
  }
  y += lineH;
  for (const [l, v] of langFields) {
    emit(field(rightX, y, l, v, rowChars));
    y += lineH;
  }
  y += lineH;
  for (const [l, v] of hobbies) {
    emit(field(rightX, y, l, v, rowChars));
    y += lineH;
  }
  y += lineH;
  emit(header(rightX, y, "- Contact", rowChars));
  y += lineH;
  for (const [l, v] of contact) {
    emit(field(rightX, y, l, v, rowChars));
    y += lineH;
  }
  y += lineH;
  emit(header(rightX, y, "- GitHub Stats", rowChars));
  y += lineH;

  // stats section: each line stretches to the SAME right edge as the rest of the
  // card (rowChars). The second field on each of the first two lines (Stars /
  // Followers) starts at the SAME x — a real column, Stars directly above Followers —
  // and its dots absorb the remaining space so the line fills the full block width.
  const shortDots = "....";
  const contribSuffix = contributed > 0 ? ` {Contributed: ${fmt(contributed)}}` : "";

  // bar ("|") column is fixed independent of contributed being shown, so it lines
  // up vertically between the two stats rows no matter how long line 1 gets
  const beforeBar1 = `. Repos: ${shortDots} ${fmt(repos)}${contribSuffix}`;
  const beforeBar2 = `. Commits: ${shortDots} ${fmt(commits)}`;
  const barCol = Math.max(beforeBar1.length, beforeBar2.length);
  const pad1 = " ".repeat(barCol - beforeBar1.length);
  const pad2 = " ".repeat(barCol - beforeBar2.length);
  const line1LeftPlain = beforeBar1 + pad1 + "  |  ";
  const line2LeftPlain = beforeBar2 + pad2 + "  |  ";
  const colStart = line1LeftPlain.length;

  const starsPrefixLen = colStart + "Stars: ".length;
  const followersPrefixLen = colStart + "Followers: ".length;
  const starsDots = ".".repeat(Math.max(3, rowChars - starsPrefixLen - fmt(stars).length));
  const followersDots = ".".repeat(Math.max(3, rowChars - followersPrefixLen - fmt(followers).length));

  const contribSvg = contributed > 0 ? ` {<tspan class="key">Contributed</tspan>: <tspan class="value">${fmt(contributed)}</tspan>}` : "";
  const statsLine1 = `<tspan x="${rightX}" y="${y}" class="cc">. </tspan><tspan class="key">Repos</tspan>:<tspan class="cc"> ${shortDots} </tspan><tspan class="value">${fmt(repos)}</tspan>${contribSvg}<tspan class="cc">${pad1}  |  </tspan><tspan class="key">Stars</tspan>:<tspan class="cc"> ${starsDots} </tspan><tspan class="value">${fmt(stars)}</tspan>`;
  lines.push(statsLine1);
  maxLen = Math.max(maxLen, (line1LeftPlain + "Stars: " + starsDots + " " + fmt(stars)).length);
  y += lineH;

  const statsLine2 = `<tspan x="${rightX}" y="${y}" class="cc">. </tspan><tspan class="key">Commits</tspan>:<tspan class="cc"> ${shortDots} </tspan><tspan class="value">${fmt(commits)}</tspan><tspan class="cc">${pad2}  |  </tspan><tspan class="key">Followers</tspan>:<tspan class="cc"> ${followersDots} </tspan><tspan class="value">${fmt(followers)}</tspan>`;
  lines.push(statsLine2);
  maxLen = Math.max(maxLen, (line2LeftPlain + "Followers: " + followersDots + " " + fmt(followers)).length);
  y += lineH;

  // dots sized against the FULL value (net + the additions/deletions parenthetical),
  // so the whole "N (+A, -D)" string's right edge lands on rowChars, not just N
  const locFullValue = `${fmt(loc.net)} ( ${fmt(loc.additions)}++, ${fmt(loc.deletions)}-- )`;
  const locDots = dots("Lines of Code", locFullValue, rowChars);
  const locPlain = `. Lines of Code: ${locDots} ${locFullValue}`;
  const statsLine3 = `<tspan x="${rightX}" y="${y}" class="cc">. </tspan><tspan class="key">Lines of Code</tspan>:<tspan class="cc"> ${locDots} </tspan><tspan class="value">${fmt(loc.net)}</tspan> ( <tspan class="add">${fmt(loc.additions)}</tspan><tspan class="add">++</tspan>, <tspan class="del">${fmt(loc.deletions)}</tspan><tspan class="del">--</tspan> )`;
  lines.push(statsLine3);
  maxLen = Math.max(maxLen, locPlain.length);
  y += lineH;

  const rightH = y;
  const artH = 30 + ART.length * lineH;
  const height = Math.max(artH, rightH) + 20;
  const width = Math.round(rightX + (maxLen + 4) * charW + 20); // safety margin for font-metric variance across renderers

  return `<svg xmlns="http://www.w3.org/2000/svg" font-family="'Courier New', ui-monospace, monospace" width="${width}px" height="${height}px" font-size="${fontSize}px">
<style>
.key {fill: ${p.key};}
.value {fill: ${p.value};}
.add {fill: ${p.add};}
.del {fill: ${p.del};}
.cc {fill: ${p.cc};}
text, tspan {white-space: pre;}
</style>
<rect width="${width}px" height="${height}px" fill="${p.bg}" rx="15"/>
<text x="${marginX}" y="30" fill="${p.fg}" xml:space="preserve">
${artTspans}
</text>
<text x="${rightX}" y="30" fill="${p.fg}" xml:space="preserve">
${lines.join("\n")}
</text>
</svg>`;
}

const repos = await getRepos();
const stars = repos.reduce((sum, r) => sum + r.stargazerCount, 0);
const commits = await getTotalCommits();
const followers = await getFollowers();
const contributed = await getContributed();
const loc = getLoc(repos);
const stats = { repos: repos.length, stars, commits, followers, contributed, loc };

writeFileSync("dark_mode.svg", card({ ...stats, theme: "dark" }));
writeFileSync("light_mode.svg", card({ ...stats, theme: "light" }));

console.log(JSON.stringify(stats, null, 2));
