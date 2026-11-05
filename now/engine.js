// 出身高校当てエンジン（ブラウザとNode共通）
(function (root) {
  const EPS = 0.08;
  const REGION_TH = 0.85;
  const NAMED_FROM = (typeof process!=='undefined' && process.env && process.env.NF) ? +process.env.NF : 14, NAMED_W = 0.8;  // 「◯◯県？」のような地名そのものの質問は、序盤は出さない
  const KQ_FROM = (typeof process!=='undefined' && process.env && process.env.KQ) ? +process.env.KQ : 10; // 県名のかわりの質問を出してよい問目
  const RAND = (typeof process!=='undefined' && process.env && process.env.RAND) ? +process.env.RAND : 0.85; // 一番よい質問の何割以上なら、その中からランダムに選ぶ（同じ学校でも毎回ちがう質問にする）
  const AVOID_W = (typeof process!=='undefined' && process.env && process.env.AW) ? +process.env.AW : 0.5; // 前回出た質問の点数を何倍にするか
  const AVOID_N = (typeof process!=='undefined' && process.env && process.env.AN) ? +process.env.AN : 5; // 何問目までその後回しをするか
  const STALL = 0.04;                     // これ以下の情報量しか得られないなら予想に進む                // 地域だけの質問を出してよい、その地域の確率                       // 覚え違い・答え間違いの余地
  const SOFT = { yes: 1, pyes: 0.75, unk: 0.5, pno: 0.25, no: 0 };
  function lik(p, a) { // a: 回答の「はい度」0〜1
    const pp = EPS * 0.5 + (1 - EPS) * p;
    return a * pp + (1 - a) * (1 - pp);
  }
  function H(ws) { let s = 0; for (const w of ws) if (w > 0) s -= w * Math.log2(w); return s; }
  function norm(ws) { const t = ws.reduce((a, b) => a + b, 0) || 1; return ws.map(w => w / t); }
  function schoolMarg(D, post) {
    const m = {};
    D.candidates.forEach((c, i) => { m[c.sid] = (m[c.sid] || 0) + post[i]; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }
  function newGame(D) {
    if (D.questions.some(q => q.dyn)) D.questions = D.questions.filter(q => !q.dyn); // 前のゲームで作った地図の質問は捨てる
    return { post: D.candidates.map(c => c.w), asked: [], excluded: new Set(), n: 0 };
  }
  function prep(D) {
    if (D._si) return;
    const idx = {}; D._schools = [];
    D._si = new Int32Array(D.candidates.length);
    D.candidates.forEach((c, i) => { if (!(c.sid in idx)) { idx[c.sid] = D._schools.length; D._schools.push(c.sid); } D._si[i] = idx[c.sid]; });
    D._ns = D._schools.length;
  }
  function Hm(D, ws, tot) { // 学校ごとに合計してからエントロピー
    const acc = D._acc || (D._acc = new Float64Array(D._ns)); acc.fill(0);
    for (let i = 0; i < ws.length; i++) acc[D._si[i]] += ws[i];
    let h = 0;
    for (let k = 0; k < acc.length; k++) { const p = acc[k] / tot; if (p > 0) h -= p * Math.log2(p); }
    return h;
  }
  var LIFE_K = (typeof process!=='undefined' && process.env && process.env.LK) ? +process.env.LK : 0, LIFE_B = (typeof process!=='undefined' && process.env && process.env.LB) ? +process.env.LB : 1;
  var PLACE_FIRST = (typeof process!=='undefined' && process.env && process.env.PF) ? +process.env.PF : 0;
  var LATE_NOPLACE = (typeof process!=='undefined' && process.env && process.env.LATE) ? +process.env.LATE : 0;
  var SKIP = (typeof process!=='undefined' && process.env && process.env.SKIP) ? process.env.SKIP.split(',') : null;
  var GEO = (typeof process!=='undefined' && process.env && process.env.GEO!==undefined) ? +process.env.GEO : 1;
  var GEO_FROM = (typeof process!=='undefined' && process.env && process.env.GF) ? +process.env.GF : 6;
  var GEO_KM = (typeof process!=='undefined' && process.env && process.env.GK) ? +process.env.GK : 40;
  var GEO_SOFT = (typeof process!=='undefined' && process.env && process.env.GS) ? +process.env.GS : 0.9;
  function geoQuestions(D, g) {
    const S = D.schools; if (!S) return [];
    const m = schoolMarg(D, g.post).filter(x => !g.excluded.has(x[0]) && S[x[0]] && S[x[0]].lat);
    if (!m.length || m[0][1] >= 0.85) return [];
    const area = []; let cum = 0;
    for (const x of m) { area.push(x); cum += x[1]; if (cum >= 0.95 || area.length >= 40) break; }
    if (area.length < 3) return [];
    const lats = area.map(x => S[x[0]].lat), lons = area.map(x => S[x[0]].lon);
    const spanKm = Math.max((Math.max(...lats) - Math.min(...lats)) * 111, (Math.max(...lons) - Math.min(...lons)) * 91);
    if (spanKm > GEO_KM) return [];
    const out = [], done = g._geoDone || (g._geoDone = new Set());
    for (const ax of ['lat', 'lon']) {
      const arr = area.slice().sort((a, b) => S[a[0]][ax] - S[b[0]][ax]);
      let c = 0, ref = null, bestd = 9;
      for (const x of arr) { const below = c, above = cum - c - x[1]; const d = Math.abs(above - below) / cum; if (d < bestd) { bestd = d; ref = x[0]; } c += x[1]; }
      if (!ref) continue;
      const key = ax + ':' + ref; if (done.has(key)) continue;
      const v = S[ref][ax], nm = S[ref].name.replace(/（.*）/, '');
      const p = D.candidates.map(cd => { const s = S[cd.sid]; if (!s || !s.lat) return 0.5; if (cd.sid === ref) return 0.5; const dv = s[ax] - v; return Math.abs(dv) < 0.002 ? 0.5 : (dv > 0 ? GEO_SOFT : 1 - GEO_SOFT); });
      const N = ax === 'lat' ? ['北', '南'] : ['東', '西'];
      out.push({ id: 'GEO_' + ax + '_' + ref, text: '学校は、' + nm + 'より' + N[0] + 'にある？', alt: '学校は、' + nm + 'より' + N[1] + 'にある？',
                 cat: '場所', look: '○', ans: 0.85, p, geoKey: key });
    }
    return out;
  }
  function nextQuestion(D, g) {
    if (g._nqN === g.n && g._nqA === g.asked.length) return g._nq;
    prep(D);
    const n = g.post.length;
    // 学校単位のエントロピー（年代は当てたい対象ではないので学校で測る）
    const curH = Hm(D, g.post, 1);
    // 地域ごとの確率（その地域だけの質問は、地域がほぼ決まってから出す）
    const reg = {};
    D.candidates.forEach((c, i) => { const r = c.region || 'gifu'; reg[r] = (reg[r] || 0) + g.post[i]; });
    let best = null, bestS = -1; const pool = [];
    if (!D._yes || D._yes.length !== n) { D._yes = new Float64Array(n); D._no = new Float64Array(n); }
    const yes = D._yes, no = D._no;
    D.questions.forEach((q, qi) => {
      if (q.look === '×' || g.asked.includes(qi) || (q.dyn && q.g !== g) || (SKIP && SKIP.indexOf(q.id) >= 0)) return;
      if (q.nm && g.n < NAMED_FROM) return;
      if ((q.kq || (q.id && q.id.indexOf('KQ_') === 0)) && g.n < KQ_FROM) return; // 県のかわり質問は、地方がしぼれてから
      if (q.cat === '場所' && LATE_NOPLACE && g.n >= LATE_NOPLACE && !g._fallback) return;
      if (PLACE_FIRST && !g._fallback) { const pl = (q.cat === '場所' || q.cat === '型'); if (g.n < PLACE_FIRST ? !pl : pl) return; }
      if (q.region) { const rs = Array.isArray(q.region) ? q.region : [q.region]; if (rs.reduce((a, r) => a + (reg[r] || 0), 0) < REGION_TH) return; }
      let py = 0;
      for (let i = 0; i < n; i++) { const w = g.post[i], l1 = EPS * 0.5 + (1 - EPS) * q.p[i]; yes[i] = w * l1; no[i] = w - yes[i]; py += yes[i]; }
      if (py <= 1e-12 || py >= 1 - 1e-12) return;
      const gain = curH - (py * Hm(D, yes, py) + (1 - py) * Hm(D, no, 1 - py));
      let sc = gain * q.ans * (q.nm ? NAMED_W : 1);
      if (g.avoid && g.n < AVOID_N && g.avoid.indexOf(q.id) >= 0) sc *= AVOID_W; // 前回出た質問は後回し
      if (LIFE_K && g.n >= LIFE_K && q.cat !== '場所' && q.cat !== '型') sc *= LIFE_B;
      pool.push([qi, sc]);
      if (sc > bestS) { bestS = sc; best = qi; }
    });
    if (RAND < 1 && pool.length > 1 && bestS > 0) { // 似たよさの質問からランダムに選ぶ（よいものほど選ばれやすい）
      const ok = pool.filter(x => x[1] >= RAND * bestS); let t = 0; ok.forEach(x => t += x[1]); let r = Math.random() * t;
      for (const x of ok) { r -= x[1]; if (r <= 0) { best = x[0]; break; } }
    }
    // 終盤：候補が近くに集まったら、地図で半分に分ける質問をその場で作る
    if (GEO && g.n >= GEO_FROM) {
      for (const q of geoQuestions(D, g)) {
        let py = 0;
        for (let i = 0; i < n; i++) { const w = g.post[i], l1 = EPS * 0.5 + (1 - EPS) * q.p[i]; yes[i] = w * l1; no[i] = w - yes[i]; py += yes[i]; }
        if (py <= 1e-12 || py >= 1 - 1e-12) continue;
        const sc = (curH - (py * Hm(D, yes, py) + (1 - py) * Hm(D, no, 1 - py))) * q.ans;
        if (sc > bestS) { bestS = sc; best = { dynq: q }; }
      }
      if (best && best.dynq) { const q = best.dynq; q.dyn = true; q.g = g; D.questions.push(q); best = D.questions.length - 1; }
    }
    if (best === null && !g._fallback && (LATE_NOPLACE || PLACE_FIRST)) { g._fallback = true; g._nqN = -1; const b = nextQuestion(D, g); g._fallback = false; return b; }
    g.bestScore = bestS; g._nq = best; g._nqN = g.n; g._nqA = g.asked.length;
    return best;
  }
  function answer(D, g, qi, key) {
    const a = SOFT[key]; g.asked.push(qi); g.n++;
    const qq = D.questions[qi]; if (qq.geoKey) (g._geoDone || (g._geoDone = new Set())).add(qq.geoKey);
    if (key === 'unk') return;
    (g.ans || (g.ans = [])).push([qi, a]);
    g.post = norm(g.post.map((w, i) => w * lik(qq.p[i], a)));
  }
  // 母校らしさ：その学校の卒業生らしい答えか、全国の平均的な答えかを比べた点（1問あたりの平均）
  function rashisa(D, g, sid) {
    const ans = (g.ans || []).filter(([qi]) => !D.questions[qi].dyn);
    const idx = []; D.candidates.forEach((c, i) => { if (c.sid === sid) idx.push(i); });
    if (!idx.length || ans.length < 3) return null;
    const w = idx.map(i => D.candidates[i].w);
    for (const [qi, a] of ans) { const q = D.questions[qi]; idx.forEach((ci, k) => { w[k] *= lik(q.p[ci], a); }); }
    const ws = w.reduce((x, y) => x + y, 0) || 1;
    let s = 0;
    for (const [qi, a] of ans) {
      const q = D.questions[qi];
      if (q._pm === undefined) { let t = 0, u = 0; D.candidates.forEach((c, i) => { t += c.w * q.p[i]; u += c.w; }); q._pm = t / u; }
      let ps = 0; idx.forEach((ci, k) => { ps += w[k] * q.p[ci]; }); ps /= ws;
      s += Math.log(lik(ps, a) / lik(q._pm, a));
    }
    return s / ans.length;
  }
  // 点を偏差値に：これまでのゲームの中での順位を、ふつうの偏差値の山の形に当てはめる
  function hensachi(D, r) {
    const R = D.rr; if (r === null || !R || R.length < 20) return null;
    let lo = 0, eq = 0; for (const x of R) { if (x < r) lo++; else if (x === r) eq++; }
    const pc = (lo + eq / 2 + 0.5) / (R.length + 1);
    // 標準正規分布の逆関数（近似）
    const t = Math.sqrt(-2 * Math.log(pc < 0.5 ? pc : 1 - pc));
    let z = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
    if (pc < 0.5) z = -z;
    return Math.max(25, Math.min(80, Math.round(50 + 10 * z)));
  }
  // 「ピンとくる？」の答え：その学校なら「はい」になりやすく、ほかの学校なら「いいえ」になりやすい
  const PIN_IN = 0.85, PIN_OUT = 0.12;
  function answerSid(D, g, sid, key) {
    const a = SOFT[key]; g.n++;
    if (key === 'unk') return;
    g._nqN = -1;
    g.post = norm(g.post.map((w, i) => w * lik(D.candidates[i].sid === sid ? PIN_IN : PIN_OUT, a)));
  }
  function top(D, g) {
    const m = schoolMarg(D, g.post).filter(x => !g.excluded.has(x[0]));
    const [sid, pr] = m[0] || [];
    // その学校の中で一番ありそうな年代
    let best = null;
    D.candidates.forEach((c, i) => { if (c.sid === sid && (!best || g.post[i] > g.post[best])) best = i; });
    return { sid, prob: pr, school: D.candidates[best].school, decade: D.candidates[best].decade,
             decadeProb: g.post[best] / pr };
  }
  function exclude(D, g, sid) {
    g.excluded.add(sid); g._nqN = -1;
    g.post = norm(g.post.map((w, i) => D.candidates[i].sid === sid ? 0 : w));
  }
  function shouldGuess(D, g) {
    const t = top(D, g);
    if (t.prob >= 0.85 || g.n >= 25 || (g.n >= 14 && t.prob >= 0.65)) return true;
    if (nextQuestion(D, g) === null) return true;
    // もう聞いても差がつかない（どの質問でも情報が少ない）なら予想する
    return g.n >= 8 && t.prob >= 0.4 && g.bestScore < STALL;
  }
  const api = { newGame, nextQuestion, answer, answerSid, top, exclude, shouldGuess, schoolMarg, rashisa, hensachi };
  if (typeof module !== 'undefined') module.exports = api; else root.Engine = api;
})(this);
