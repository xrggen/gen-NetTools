import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { parseBrand, type AiSettings, type Brand, type Feature, type HistoryRecord, type Knowledge, type Rule, type RuleBatchPreference, type Summary } from '../shared/contracts';

export const initialSettings: AiSettings = { enabled: false, baseUrl: '', model: '', remembered: {} };

export function openStore(path: string) {
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS brand_rule_variants (
      id INTEGER PRIMARY KEY, vendor TEXT NOT NULL,
      module TEXT NOT NULL, severity TEXT NOT NULL, event TEXT NOT NULL,
      fingerprint TEXT NOT NULL, content TEXT NOT NULL,
      UNIQUE (vendor, module, severity, event, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS brand_rule_choices (
      vendor TEXT NOT NULL, module TEXT NOT NULL, severity TEXT NOT NULL, event TEXT NOT NULL,
      variant_id INTEGER NOT NULL REFERENCES brand_rule_variants(id),
      PRIMARY KEY (vendor, module, severity, event)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS brand_rule_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, vendor TEXT NOT NULL, name TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS brand_rule_pending_imports (
      vendor TEXT NOT NULL, module TEXT NOT NULL, severity TEXT NOT NULL, event TEXT NOT NULL,
      batch_id INTEGER NOT NULL REFERENCES brand_rule_imports(id),
      existing_id INTEGER REFERENCES brand_rule_variants(id), incoming_id INTEGER REFERENCES brand_rule_variants(id),
      PRIMARY KEY (vendor, module, severity, event)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS brand_rule_pending_batch ON brand_rule_pending_imports(batch_id);
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY, feature TEXT NOT NULL, at TEXT NOT NULL, summary TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS history_feature ON history(feature, id DESC);
    CREATE TABLE IF NOT EXISTS preferences (name TEXT PRIMARY KEY, content TEXT NOT NULL);
  `);
  try { migrateProductRules(db); return db; }
  catch (error) { db.close(); throw error; }
}

function migrateProductRules(db: DatabaseSync) {
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA user_version').get()?.user_version === 0) {
      const legacy = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='rules'").get();
      if (legacy) {
        const source = db.prepare('SELECT vendor, product, version, content FROM rules ORDER BY vendor, product, version, module, severity, event');
        const normalized: Rule[] = [];
        for (const entry of source.iterate()) {
          const brand = parseBrand(entry.vendor);
          if (!brand) continue;
          const { module, severity, event, template, meaning, parameters, causes, steps, source: originalSource } = JSON.parse(String(entry.content)) as Rule;
          normalized.push({ vendor: brand, module, severity, event, template, meaning, parameters, causes, steps,
            source: [entry.product, entry.version, originalSource].filter(Boolean).join(' · ') });
        }
        addVariants(db, normalized);
      }
      db.exec('PRAGMA user_version = 1');
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

type RuleKey = readonly [Brand, string, string, string];
type ImportedGroup = { key: RuleKey; before: number[]; active?: number; incoming: Set<number>; changed: boolean };
type ImportSource = { brand: Brand; name: string; format: 'html' | 'json' };

function addDocumentSource(rule: Rule, source: string, directory: string) {
  const sources = [rule.source, ...(rule.additionalSources ?? [])];
  if (sources.includes(source)) return;
  const prefix = directory + ' · ';
  const unqualified = directory && source.startsWith(prefix) ? sources.indexOf(source.slice(prefix.length)) : -1;
  if (unqualified >= 0) sources[unqualified] = source;
  else sources.push(source);
  const [primary, ...additionalSources] = sources;
  return { ...rule, source: primary, additionalSources: additionalSources.length ? additionalSources : undefined };
}

function pruneRuleImports(db: DatabaseSync) {
  db.exec('DELETE FROM brand_rule_imports WHERE id NOT IN (SELECT batch_id FROM brand_rule_pending_imports)');
}

function trackRuleImport(db: DatabaseSync, source: ImportSource, groups: Iterable<ImportedGroup>) {
  const pending = db.prepare('SELECT 1 FROM brand_rule_pending_imports WHERE vendor=? AND module=? AND severity=? AND event=?');
  const batch = db.prepare('INSERT INTO brand_rule_imports(vendor,name,at) VALUES (?,?,?)');
  const save = db.prepare('INSERT INTO brand_rule_pending_imports(vendor,module,severity,event,batch_id,existing_id,incoming_id) VALUES (?,?,?,?,?,?,?)');
  let batchId: number | bigint | undefined;
  let tracked = 0;
  for (const { key, before, active, incoming, changed } of groups) {
    const others = before.filter(id => !incoming.has(id));
    if (incoming.size + others.length < 2) continue;
    // A repeated import can identify older pending conflicts that have no recorded batch.
    if (!changed && (active !== undefined || !others.length || pending.get(...key))) continue;
    const existing = active ?? (others.length === 1 ? others[0] : null);
    const imported = incoming.size === 1 ? incoming.values().next().value! : null;
    batchId ??= batch.run(source.brand, source.name, new Date().toISOString()).lastInsertRowid;
    save.run(...key, batchId, existing, imported);
    tracked++;
  }
  return tracked;
}

function addVariants(db: DatabaseSync, rules: Rule[], source?: ImportSource) {
  const insert = db.prepare('INSERT INTO brand_rule_variants(vendor,module,severity,event,fingerprint,content) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING');
  const count = db.prepare('SELECT count(*) AS count FROM brand_rule_variants WHERE vendor=? AND module=? AND severity=? AND event=?');
  const reset = db.prepare('DELETE FROM brand_rule_choices WHERE vendor=? AND module=? AND severity=? AND event=?');
  const untrack = db.prepare('DELETE FROM brand_rule_pending_imports WHERE vendor=? AND module=? AND severity=? AND event=?');
  const previous = db.prepare(`SELECT v.id, c.variant_id FROM brand_rule_variants v LEFT JOIN brand_rule_choices c USING(vendor,module,severity,event)
    WHERE v.vendor=? AND v.module=? AND v.severity=? AND v.event=?`);
  const duplicate = db.prepare('SELECT id,content FROM brand_rule_variants WHERE vendor=? AND module=? AND severity=? AND event=? AND fingerprint=?');
  const saveContent = db.prepare('UPDATE brand_rule_variants SET content=? WHERE id=?');
  const groups = new Map<string, ImportedGroup>();
  let added = 0;
  let duplicates = 0;
  const conflicts = new Set<string>();
  for (const rule of rules) {
    const key: RuleKey = [rule.vendor, rule.module, rule.severity, rule.event];
    const identifier = key.join('/');
    let group = groups.get(identifier);
    if (source?.brand === rule.vendor && !group) {
      const rows = previous.all(...key);
      const before = rows.map(row => Number(row.id));
      const choice = rows[0]?.variant_id;
      group = { key, before, active: before.length === 1 ? before[0] : choice == null ? undefined : Number(choice), incoming: new Set(), changed: false };
      groups.set(identifier, group);
    }
    const parameters = rule.parameters.map(field => JSON.stringify([field.name, field.meaning])).sort();
    const fingerprint = createHash('sha256').update(JSON.stringify([rule.template, rule.meaning, parameters, rule.causes, rule.steps])).digest('hex');
    const write = insert.run(...key, fingerprint, JSON.stringify(rule));
    if (!write.changes) {
      duplicates++;
      if (group) {
        const existing = duplicate.get(...key, fingerprint)!;
        group.incoming.add(Number(existing.id));
        if (source?.format === 'html') {
          const updated = addDocumentSource(JSON.parse(String(existing.content)) as Rule, rule.source, source.name);
          if (updated) saveContent.run(JSON.stringify(updated), existing.id);
        }
      }
      continue;
    }
    group?.incoming.add(Number(write.lastInsertRowid));
    if (group) group.changed = true;
    if (Number(count.get(...key)?.count) === 1) added++;
    else { reset.run(...key); untrack.run(...key); conflicts.add(identifier); }
  }
  const tracked = source ? trackRuleImport(db, source, groups.values()) : 0;
  pruneRuleImports(db);
  return { added, duplicates, conflicts: conflicts.size, tracked };
}

export function insertRules(db: DatabaseSync, rules: Rule[], source?: ImportSource) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = addVariants(db, rules, source);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getBrandKnowledge(db: DatabaseSync, brand: Brand): Knowledge {
  const variants = db.prepare(`SELECT v.id, v.module, v.severity, v.event, v.content, c.variant_id AS choice
    FROM brand_rule_variants v LEFT JOIN brand_rule_choices c USING (vendor, module, severity, event)
    WHERE v.vendor=? ORDER BY v.module, v.severity, v.event, v.id`);
  const groups = new Map<string, { choice: number | null; candidates: { id: number; rule: Rule }[] }>();
  for (const entry of variants.iterate(brand)) {
    const identifier = [entry.module, entry.severity, entry.event].join('/');
    const group = groups.get(identifier) ?? { choice: entry.choice == null ? null : Number(entry.choice), candidates: [] };
    group.candidates.push({ id: Number(entry.id), rule: JSON.parse(String(entry.content)) as Rule });
    groups.set(identifier, group);
  }
  const batches = db.prepare(`SELECT b.id, b.name, b.at, count(*) AS pending, count(p.existing_id) AS existing, count(p.incoming_id) AS incoming
    FROM brand_rule_imports b JOIN brand_rule_pending_imports p ON p.batch_id=b.id
    LEFT JOIN brand_rule_choices c ON c.vendor=p.vendor AND c.module=p.module AND c.severity=p.severity AND c.event=p.event
    WHERE b.vendor=? AND c.variant_id IS NULL GROUP BY b.id ORDER BY b.id DESC`).all(brand).map(row => ({
    id: Number(row.id), name: String(row.name), at: String(row.at), pending: Number(row.pending),
    existing: Number(row.existing), incoming: Number(row.incoming),
  }));
  const result: Knowledge = { rows: [], conflicts: [], batches };
  for (const [identifier, group] of groups) {
    const active = group.candidates.length === 1 ? group.candidates[0] : group.candidates.find(candidate => candidate.id === group.choice);
    if (active) result.rows.push(active.rule);
    else result.conflicts.push({ identifier, candidates: group.candidates });
  }
  return result;
}

export function chooseBrandRule(db: DatabaseSync, brand: Brand, id: number) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const selected = db.prepare(`INSERT INTO brand_rule_choices(vendor,module,severity,event,variant_id)
      SELECT v.vendor,v.module,v.severity,v.event,v.id FROM brand_rule_variants v
      WHERE v.vendor=? AND v.id=? AND EXISTS (SELECT 1 FROM brand_rule_variants other
        WHERE other.vendor=v.vendor AND other.module=v.module AND other.severity=v.severity AND other.event=v.event AND other.id<>v.id)
      ON CONFLICT(vendor,module,severity,event) DO UPDATE SET variant_id=excluded.variant_id`).run(brand, id);
    if (!selected.changes) throw new Error('这个冲突条目已不存在。');
    db.prepare(`DELETE FROM brand_rule_pending_imports AS p WHERE p.vendor=? AND EXISTS (SELECT 1 FROM brand_rule_variants v
      WHERE v.id=? AND v.vendor=p.vendor AND v.module=p.module AND v.severity=p.severity AND v.event=p.event)`).run(brand, id);
    pruneRuleImports(db);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function chooseBrandRuleBatch(db: DatabaseSync, brand: Brand, id: number, preference: RuleBatchPreference) {
  const column = preference === 'existing' ? 'existing_id' : 'incoming_id';
  db.exec('BEGIN IMMEDIATE');
  try {
    const selected = db.prepare(`INSERT INTO brand_rule_choices(vendor,module,severity,event,variant_id)
      SELECT vendor,module,severity,event,${column} FROM brand_rule_pending_imports
      WHERE vendor=? AND batch_id=? AND ${column} IS NOT NULL
      ON CONFLICT(vendor,module,severity,event) DO NOTHING`).run(brand, id);
    if (!selected.changes) throw new Error('该批次没有可按所选版本处理的待选释义。');
    db.prepare(`DELETE FROM brand_rule_pending_imports AS p WHERE p.vendor=? AND p.batch_id=? AND EXISTS
      (SELECT 1 FROM brand_rule_choices c WHERE c.vendor=p.vendor AND c.module=p.module AND c.severity=p.severity AND c.event=p.event)`).run(brand, id);
    pruneRuleImports(db);
    db.exec('COMMIT');
    return Number(selected.changes);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function recordSuccess(db: DatabaseSync, feature: Feature, summary: Summary) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO history(feature, at, summary) VALUES (?, ?, ?)').run(feature, new Date().toISOString(), JSON.stringify(summary));
    db.prepare(`DELETE FROM history WHERE feature=? AND id NOT IN
      (SELECT id FROM history WHERE feature=? ORDER BY id DESC LIMIT 3)`).run(feature, feature);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getHistory(db: DatabaseSync): HistoryRecord[] {
  return db.prepare('SELECT id, feature, at, summary FROM history ORDER BY id DESC').all().map(row => ({
    id: Number(row.id), feature: row.feature as Feature, at: String(row.at), summary: JSON.parse(String(row.summary)),
  }));
}

export function getSettings(db: DatabaseSync): AiSettings {
  const entry = db.prepare("SELECT content FROM preferences WHERE name='ai'").get();
  return entry ? JSON.parse(String(entry.content)) as AiSettings : initialSettings;
}

export function storeSettings(db: DatabaseSync, settings: AiSettings) {
  db.prepare("INSERT INTO preferences VALUES ('ai',?) ON CONFLICT(name) DO UPDATE SET content=excluded.content")
    .run(JSON.stringify(settings));
  return settings;
}

export function getProtectedModelKey(db: DatabaseSync): Buffer | undefined {
  const entry = db.prepare("SELECT content FROM preferences WHERE name='model-access'").get();
  return entry ? Buffer.from(String(entry.content), 'base64') : undefined;
}

export function saveModelSettings(db: DatabaseSync, settings: AiSettings, protectedKey?: Uint8Array | null) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (protectedKey === null) db.prepare("DELETE FROM preferences WHERE name='model-access'").run();
    else if (protectedKey) db.prepare("INSERT INTO preferences VALUES ('model-access',?) ON CONFLICT(name) DO UPDATE SET content=excluded.content")
      .run(Buffer.from(protectedKey).toString('base64'));
    storeSettings(db, settings);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
