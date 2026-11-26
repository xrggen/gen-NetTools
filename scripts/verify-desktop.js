async (fixture, mock, imports) => {
  function expect(condition, message) { if (!condition) throw new Error(message); }
  for (let attempt = 0; attempt < 40 && !document.querySelector('nav'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  expect(document.title === 'gen-NetTools' && document.querySelector('nav'), '窗口未渲染。');
  const api = window.nettools;
  const nav = name => Array.from(document.querySelectorAll('nav button')).find(button => button.textContent.includes(name));
  expect(nav('自动化下发'), '自动化下发入口未渲染。');
  nav('自动化下发').click();
  for (let attempt = 0; attempt < 40 && !document.querySelector('.deployment'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  const deployment = document.querySelector('.deployment');
  const deploymentButton = label => Array.from(deployment.querySelectorAll('button')).find(button => button.textContent === label);
  expect(deployment && deploymentButton('下载设备模板') && deploymentButton('下载脚本模板'), '设备和脚本模板入口未渲染。');
  expect(deploymentButton('测试连接和认证').disabled && deploymentButton('准备下发').disabled, '无设备时应限制测试与下发。');
  expect(!deployment.querySelector('.deployment-risk input').checked, '自动回复 Y 应在轮次开始前关闭。');
  expect((await api.deployment.history()).length === 0, '新数据目录不应已有下发历史。');
  let deploymentRejected = false;
  try { await api.deployment.run({ common: '', overrides: {}, intervalMs: 0, concurrency: 1, autoYes: false }); }
  catch { deploymentRejected = true; }
  expect(deploymentRejected, '后台允许绕过连接测试。');
  nav('日志分析').click();
  const brands = await api.brands();
  const brand = brands.find(brand => brand === 'Huawei');
  expect(brand, '没有内置华为规则。');
  const knowledge = await api.knowledge(brand);
  expect(knowledge.rows.length > 1900, '内置条目数低于本期资料预期。');
  const update = { feature: 'knowledge', brand, directory: fixture, format: 'json' };
  const imported = await api.run(update);
  expect(imported.summary.map(item => item.value).join(',') === '1,2,1,1,0', '品牌去重或释义冲突统计不正确。');
  const repeated = await api.run(update);
  expect(repeated.summary.map(item => item.value).join(',') === '0,4,0,1,0', '重复导入没有跳过。');
  const conflict = (await api.knowledge(brand)).conflicts.find(item => item.identifier.endsWith('/SYNTHETIC_REGRESSION_CHECK'));
  expect(conflict?.candidates.length === 2, '不同释义没有进入手动选择。');
  const conflictingInput = { feature: 'logs', brand, input: { text: `%%01${conflict.identifier}(l)[1]: 测试日志` } };
  expect((await api.run(conflictingInput)).rows[0].status === 'conflict', '未选择释义前使用了某条冲突规则。');
  const choice = conflict.candidates.find(candidate => candidate.rule.meaning === '手动选择的替代释义');
  await api.chooseRule(brand, choice.id);
  expect((await api.run(conflictingInput)).rows[0].rule.meaning === choice.rule.meaning, '手动选择的规则未生效。');
  const original = knowledge.conflicts.find(item => item.identifier.endsWith('/BATCH_EXISTING'));
  await api.chooseRule(brand, original.candidates.find(candidate => candidate.rule.meaning === '原有生效释义').id);
  await api.run({ ...update, directory: imports.incoming });
  let batchState = await api.knowledge(brand);
  const individual = batchState.conflicts.find(item => item.identifier.endsWith('/BATCH_INDIVIDUAL'));
  await api.chooseRule(brand, individual.candidates.find(candidate => candidate.rule.meaning === '导入释义').id);
  nav('字段知识库').click();
  for (let attempt = 0; attempt < 40 && !document.querySelector('.rule-batch'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  const form = document.querySelector('.rule-batch');
  expect(form?.querySelector('button').disabled && form.textContent.includes('fixture-batch.json'), '批量选择未显示本批次，或已预选释义。');
  const version = form.querySelector('select option[value="existing"]').parentElement;
  version.value = 'existing';
  version.dispatchEvent(new Event('change', { bubbles: true }));
  for (let attempt = 0; attempt < 40 && form.querySelector('button').disabled; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  expect(form.querySelector('button').textContent.includes('2 条'), '批量选择统计了手动确认的条目。');
  expect(form.querySelector('small')?.textContent.includes('另有 1 条'), '界面未提示原有候选不唯一的条目。');
  form.querySelector('button').click();
  for (let attempt = 0; attempt < 40 && !document.querySelector('.rule-batch-note[role="status"]'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  expect(document.querySelector('.rule-batch-note[role="status"]')?.textContent.includes('2 条'), '界面没有报告批量选择的结果。');
  batchState = await api.knowledge(brand);
  const meaning = name => batchState.rows.find(item => item.event === name)?.meaning;
  expect(meaning('BATCH_EXISTING') === '原有生效释义' && meaning('BATCH_OTHER') === '原有生效释义', '批量保留未采用导入前的释义。');
  expect(meaning('BATCH_INDIVIDUAL') === '导入释义' && meaning('BATCH_NEW') === '导入释义', '批量保留覆盖了手动选择或新增标识。');
  expect(batchState.conflicts.some(item => item.identifier.endsWith('/BATCH_MULTIPLE')), '批量保留替用户选了未确认的旧候选。');
  const legacyImport = await api.run({ ...update, directory: imports.legacy });
  expect(legacyImport.summary[1].value === 1, '重导入旧版资料没有去重。');
  batchState = await api.knowledge(brand);
  const legacyBatch = batchState.batches.find(item => item.name === 'fixture-legacy.json');
  expect(legacyBatch?.pending === 1, '重导入没有关联旧版待选释义。');
  expect(await api.chooseRuleBatch(brand, legacyBatch.id, 'incoming') === 1, '批量采用本批释义没有应用到预期条目。');
  batchState = await api.knowledge(brand);
  expect(meaning('BATCH_LEGACY') === '旧版导入的替代释义' && batchState.conflicts.some(item => item.identifier.endsWith('/BATCH_UNRELATED')), '批量选择采用了错误版本或影响其他冲突。');
  nav('日志分析').click();
  const pattern = { ...update, format: 'html' };
  const parentDirectory = 'CloudEngine XH9000, XH8000_V300R026C00/resources/v300r026c00/log';
  const selectedDirectory = 'CloudEngine 9800, 8800, 6800, 5800_V200R025C00';
  const attached = await api.run({ ...pattern, directory: imports.parentProduct });
  expect(attached.summary.slice(0, 3).map(item => item.value).join(',') === '1,1,0', '补齐旧候选来源时新增了候选或跳过了新标识。');
  await api.run({ ...pattern, directory: imports.selectedProduct });
  await api.run({ ...pattern, directory: imports.parentProduct });
  const documentKnowledge = await api.knowledge(brand);
  const documentConflict = documentKnowledge.conflicts.find(item => item.identifier === 'AAA/6/SYNTHETIC_SOURCE_REFERENCE');
  const firstSource = documentConflict?.candidates.find(item => item.rule.causes === '测试原因一')?.rule;
  const otherSource = documentConflict?.candidates.find(item => item.rule.causes === '测试原因二')?.rule;
  expect(documentConflict?.candidates.length === 2 && firstSource?.source === `${parentDirectory} · source-reference.html · SYNTHETIC_LOGREF`
    && firstSource.additionalSources?.length === 1 && firstSource.additionalSources[0].startsWith(selectedDirectory + ' · identical-rule.html')
    && otherSource?.source.startsWith(selectedDirectory + ' · source-reference.html'), '产品路径、旧候选来源补齐或重复规则来源合并失败。');
  expect(documentKnowledge.rows.some(item => item.event === 'SYNTHETIC_NEW_SOURCE_REFERENCE' && item.source.startsWith(parentDirectory))
    && documentKnowledge.batches.some(item => item.name === parentDirectory), '新规则或导入批次没有保留产品目录。');
  nav('字段知识库').click();
  const findDocument = () => Array.from(document.querySelectorAll('.rule-list button')).find(button => button.textContent.includes('AAA/6/SYNTHETIC_SOURCE_REFERENCE'));
  for (let attempt = 0; attempt < 40 && !findDocument(); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  findDocument()?.click();
  for (let attempt = 0; attempt < 40 && !document.querySelector('.rule-options .rule-sources'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  const visibleSources = document.querySelector('.rule-options')?.textContent;
  expect(visibleSources?.includes(parentDirectory) && visibleSources.includes(selectedDirectory), '待选释义界面没有显示产品路径。');
  nav('日志分析').click();
  const log = await api.run({ feature: 'logs', brand,
    input: { text: 'Nov 15 12:00:00 Switch %%01ARP/4/ARP_DUPLICATE_IPADDR(l): Received an ARP packet with a duplicate IP address from the interface. (InterfaceName=Vlanif100, IpAddress=192.0.2.10, MacAddress=00e0-fc00-0001, PE-VLAN=100, CE-VLAN=100)' } });
  expect(log.total === 1 && log.rows[0].rule?.meaning && log.rows[0].fields.some(field => field.value === '192.0.2.10'), '日志匹配或字段值提取失败。');
  const suffixes = [
    'NTP/4/LEAP_CHANGE(l)[50]:System leap changed from 3 to 0 after clock update.',
    'NTP/4/PEER_SELE(l)[51]:The peer selected by the system is 192.0.2.38.',
    'NTP/4/SOURCE_LOST(l)[52]:System synchronization source lost.',
    'DEFD/4/CPCAR_DROP_MPU(l)[53]:Some packets are dropped by CPCAR. (Packet-Type=unknown-packet, wired, Drop-Count=232)',
    'NTP/4/PEER_SELE(l)[54]:The peer selected by the system is 192.0.2.39.',
    'NTP/4/STRATUM_CHANGE(l)[55]:System stratum changed from 16 to 4 after clock update.',
    'NTP/4/LEAP_CHANGE(l)[56]:System leap changed from 3 to 0 after clock update.',
    'NTP/4/PEER_SELE(l)[57]:The peer selected by the system is 192.0.2.39.',
    'NTP/4/SOURCE_LOST(l)[58]:System synchronization source lost.',
  ];
  const cli = await api.run({ feature: 'logs', brand, input: { text: suffixes.map(line => `Nov 15 2026 05:10:45.374.2+08:00 Test-Huawei %%01${line}`).join('\n') } });
  expect(cli.total === 9 && cli.rows.every(row => row.rule?.meaning), 'CLI 序号格式、品牌内已知别名或无括号正文未匹配。');
  expect(cli.rows[0].fields.some(field => field.value === '3') && cli.rows[0].fields.some(field => field.value === '0'), 'CLI 正文中的位置字段提取失败。');
  expect(cli.rows[3].observed.some(field => field.name === 'Drop-Count' && field.value === '232'), 'CPCAR 实际正文中的丢包数量未提取。');
  const headerVariations = await api.run({ feature: 'logs', brand, input: { text: '%%01NTP/4/SOURCE_LOST:System synchronization source lost.\n%%01NTP/4/SOURCE_LOST[58]:System synchronization source lost.\n%%01NTP/4/SOURCE_LOST(l):System synchronization source lost.' } });
  expect(headerVariations.rows.length === 3 && headerVariations.rows.every(row => row.rule), '日志头有无标志或序号兼容失败。');
  document.querySelector('nav button:last-child').click();
  for (let attempt = 0; attempt < 40 && !document.querySelector('[aria-label="软件更新"]'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  const ota = await api.updateStatus();
  const otaPanel = document.querySelector('[aria-label="软件更新"]');
  const check = Array.from(otaPanel?.querySelectorAll('button') ?? []).find(button => button.textContent === '检查更新');
  const beta = /-b[1-9]\d*$/.test(ota.version);
  expect(ota.state === 'configuration-required' && /^\d+\.\d+\.\d+(?:-b[1-9]\d*)?$/.test(ota.version) &&
    ota.channel === (beta ? 'beta' : 'stable') && !ota.hasAccess && check?.disabled,
    'OTA 初始状态、版本或无凭据时的检查限制错误。');
  expect(!otaPanel.querySelector('input[type="password"]') && !otaPanel.textContent.includes('清除已保存凭据'), 'OTA 凭据编辑入口仍可见。');
  const alternateChannel = beta ? 'stable' : 'beta';
  const savedOta = await api.configureUpdate({ source: 'online', channel: alternateChannel });
  expect(savedOta.channel === alternateChannel && !savedOta.hasAccess && !Object.hasOwn(savedOta, 'access'), 'OTA 通道设置或授权状态错误。');
  for (const access of [{ mode: 'replace', value: 'synthetic-smoke-ota-access-00000000' }, { mode: 'clear' }]) {
    let refused = false;
    try { await api.configureUpdate({ source: 'online', channel: alternateChannel, access }); }
    catch (error) { refused = String(error.message).includes('授权由部署方管理'); }
    expect(refused, 'OTA IPC 允许用户修改授权。');
  }
  await api.configureUpdate({ source: 'online', channel: ota.channel });
  const config = { feature: 'config', mode: 'exact', before: { text: '# a\r\nport 1\n' }, after: { text: '# A\nport 1 \n' } };
  await api.run(config);
  const diff = await api.run(config);
  expect(diff.total === 2 && diff.rows[0].before.endsWith('\r\n'), '配置空白或换行差异丢失。');
  const heading = '<HUAWEI> display ip routing-table\nRouting Table : _public_\nDestinations : 1 Routes : 2\nDestination/Mask Proto Pre Cost Flags NextHop Interface\n';
  const route = await api.run({ feature: 'routes', before: { text: heading + '192.0.2.0/24 Static 60 0 D 192.0.2.1 Vlanif10\n Static 60 0 D 192.0.2.2 Vlanif20' },
    after: { text: heading + '192.0.2.0/24 Static 60 0 D 192.0.2.3 Vlanif30\n Static 65 30 RD 192.0.2.1 Vlanif10' } });
  expect(route.total === 1 && route.rows[0].before.length === 2 && route.rows[0].after.length === 2, 'IPv4 ECMP 未被正确分组。');
  const paths = route.rows[0].pathChanges;
  const modifiedPath = paths.find(path => path.change === 'modified');
  expect(paths.length === 3 && modifiedPath?.before.nextHop === '192.0.2.1' &&
    modifiedPath.fields.join() === 'preference,cost,flags' &&
    paths.some(path => path.change === 'removed' && path.before.nextHop === '192.0.2.2') &&
    paths.some(path => path.change === 'added' && path.after.nextHop === '192.0.2.3'), 'ECMP 路径增减或保留路径属性变化有误。');
  const reordered = await api.run({ feature: 'routes',
    before: { text: heading + '192.0.2.0/24 Static 60 0 D 192.0.2.1 GigabitEthernet 1/0/1\n Static 60 0 D 192.0.2.2 Vlanif20' },
    after: { text: heading + '192.0.2.0/24 Static 60 0 D 192.0.2.2 Vlanif20\n Static 60 0 D 192.0.2.1 GigabitEthernet1/0/1' } });
  expect(reordered.total === 0 && reordered.routes.coverage[0].after === 1, '路径重排或带空格的出口名称被误判为变化。');
  const v6Text = interfaceName => '<HUAWEI> display ipv6 routing-table vpn-instance VRF-A\nRouting Table : VRF-A\n' +
    'Destinations : 1 Routes : 1\nDestination : 2001:db8::    PrefixLength : 64\nNextHop : 2001:db8::1    Preference : 60\n' +
    'Cost : 0    Protocol : Static\nRelayNextHop : ::    TunnelID : 0x0\nInterface : ' + interfaceName + '    Flags : D';
  const v6 = await api.run({ feature: 'routes', before: { text: v6Text('Vlanif10') }, after: { text: v6Text('Vlanif11') } });
  expect(v6.total === 1 && v6.rows[0].family === 6 && v6.rows[0].table === 'VRF-A', '普通 IPv6 分块或 VRF 解析失败。');
  const unlabelledRoute = hop => 'Destination/Mask Proto Pre Cost Flags NextHop Interface\n' + '192.0.2.0/24 Static 60 0 D ' + hop + ' Vlanif10\n';
  const namedRoute = name => 'Routing Table : ' + name + '\nDestinations : 1 Routes : 1\n' + unlabelledRoute('192.0.2.1');
  const full = await api.run({ feature: 'routes', before: { text: unlabelledRoute('192.0.2.1') + namedRoute('VRF-OLD') },
    after: { text: '<HUAWEI> display ip routing-table\n' + unlabelledRoute('192.0.2.2') + namedRoute('VRF-NEW') + v6Text('Vlanif11') }, beforeScope: '  ' });
  const byTable = table => full.rows.find(item => item.table === table);
  expect(full.total === 4 && byTable('Public')?.change === 'modified' &&
    byTable('VRF-OLD')?.coverage === 'before' && byTable('VRF-NEW')?.coverage === 'after' &&
    byTable('VRF-A')?.coverage === 'after' && byTable('VRF-A').family === 6,
    'VRF 留空时没有按表和地址族进行全量比对。');
  expect(full.routes.counts.scopeOnly === 3 && full.routes.counts.added === 0 && full.routes.counts.removed === 0 &&
    full.routes.coverage.find(scope => scope.table === 'Public')?.before === 1 &&
    full.routes.coverage.find(scope => scope.table === 'VRF-OLD')?.after === undefined, '单侧覆盖被当作确认新增或删除。');
  const scopesOnly = await api.routePage(0, { change: 'scopeOnly', family: 6, protocol: 'Static' });
  expect(scopesOnly.total === 1 && scopesOnly.rows[0].table === 'VRF-A' && scopesOnly.groups[0].counts.scopeOnly === 1,
    '变化类型、地址族和协议组合筛选失败。');
  const scoped = await api.run({ feature: 'routes', before: { text: unlabelledRoute('192.0.2.1') },
    after: { text: unlabelledRoute('192.0.2.2') }, beforeScope: 'VRF-MANUAL', afterScope: 'VRF-MANUAL' });
  expect(scoped.total === 1 && scoped.rows[0].table === 'VRF-MANUAL', '手动指定的 VRF 没有生效。');
  const emptied = await api.run({ feature: 'routes', before: { text: unlabelledRoute('192.0.2.1') },
    after: { text: '<HUAWEI> display ip routing-table\nRouting Table : _public_\nSummary Count : 0' } });
  expect(emptied.routes.coverage[0].after === 0 && emptied.routes.counts.removed === 1 && emptied.routes.counts.scopeOnly === 0,
    '确认采集的空表被误判为未覆盖。');

  function manyRoutes(after) {
    return 'Destination/Mask Proto Pre Cost Flags NextHop Interface\n' +
      Array.from({ length: 52 }, (_, index) => '198.51.100.' + index + '/32 Static 60 ' + (after ? 30 : 10) + ' D 192.0.2.1 Vlanif10\n').join('') +
      '0.0.0.0/0 Static 60 0 D ' + (after ? '192.0.2.3' : '192.0.2.2') + ' Vlanif10\n' +
      (after ? '' : ' Static 60 0 D 192.0.2.4 Vlanif20\n') + (after ? v6Text('Vlanif11') : '');
  }
  nav('路由比对').click();
  function enter(selector, value, type) {
    const element = document.querySelector(selector);
    Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
  async function waitFor(check, message) {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(message);
  }
  const findButton = (selector, label) => Array.from(document.querySelectorAll(selector)).find(button => button.textContent.includes(label));
  await waitFor(() => document.querySelector('textarea[aria-label="变更后"]'), '路由输入未显示。');
  enter('textarea[aria-label="变更前"]', manyRoutes(false), HTMLTextAreaElement);
  enter('textarea[aria-label="变更后"]', manyRoutes(true), HTMLTextAreaElement);
  await waitFor(() => !findButton('main button', '开始比对').disabled, '路由快照没有进入输入框。');
  findButton('main button', '开始比对').click();
  await waitFor(() => document.querySelectorAll('.route-rows > li').length === 50, '首批路由比对结果未显示。');
  expect(document.querySelector('.route-coverage').open && document.querySelector('.route-coverage').textContent.includes('未覆盖') &&
    document.querySelector('.route-delta').textContent.includes('Cost 10 → 30'), '覆盖提醒或行内摘要未显示。');
  const publicGroup = document.querySelector('.route-group h3 button');
  expect(publicGroup.textContent.includes('修改 53'), 'VRF 组内统计受当前页限制。');
  publicGroup.click();
  await waitFor(() => !document.querySelector('.route-rows') && publicGroup.getAttribute('aria-expanded') === 'false', 'VRF 组未折叠。');
  publicGroup.click();
  await waitFor(() => document.querySelector('.route-rows details'), 'VRF 组未重新展开。');
  const firstRoute = document.querySelector('.route-rows details');
  firstRoute.querySelector('summary').click();
  expect(firstRoute.open && firstRoute.querySelector('table')?.textContent.includes('Cost'), '展开后未显示字段级差异。');
  findButton('.route-overview button', '仅一侧覆盖').click();
  await waitFor(() => document.querySelector('.route-rows')?.textContent.includes('2001:db8::/64'), '点击总览未筛选到首屏之外的 VRF。');
  findButton('.route-filters button', '清除筛选').click();
  await waitFor(() => document.querySelectorAll('.route-rows > li').length === 50, '清除筛选未恢复结果。');
  enter('.route-filters input', '198.51.100.51/32', HTMLInputElement);
  findButton('.route-filters button', '搜索').click();
  await waitFor(() => document.querySelectorAll('.route-rows > li').length === 1 &&
    document.querySelector('.route-rows')?.textContent.includes('198.51.100.51/32'), '前缀搜索没有覆盖其他页。');
  const defaults = await api.routePage(0, { focus: 'default', table: 'Public' });
  const hops = await api.routePage(0, { focus: 'nextHop' });
  const fewer = await api.routePage(0, { focus: 'fewerPaths' });
  const secondPage = await api.routePage(50, {});
  expect([defaults, hops, fewer].every(result => result.total === 1 && result.rows[0].prefix === '0.0.0.0/0') &&
    secondPage.total === 54 && secondPage.rows.length === 4, '快速筛选或跨页数据不正确。');
  const routeHistory = (await api.history()).filter(row => row.feature === 'routes').map(row => row.id);
  let truncatedRejected = false;
  try { await api.run({ feature: 'routes', before: { text: heading + '192.0.2.0/24 Static 60 0 D 192.0.2.1 Vlanif10' }, after: { text: heading } }); }
  catch { truncatedRejected = true; }
  expect(truncatedRejected, '截断的路由表被当作完整快照。');
  await api.run(config);
  await api.run(config);
  const history = await api.history();
  expect(history.filter(row => row.feature === 'config').length === 3, '配置成功历史没有保留三次。');
  expect(history.filter(row => row.feature === 'routes').map(row => row.id).join() === routeHistory.join(), '失败任务进入了历史。');
  expect(!JSON.stringify(history).includes('192.0.2.') && !JSON.stringify(history).includes('port 1'), '完整原文进入了历史。');
  await api.saveSettings({ enabled: false, baseUrl: '', model: '', remembered: { logs: 'selection', routes: 'full' } });
  const settings = await api.settings();
  expect(settings.remembered.logs === 'selection' && settings.remembered.routes === 'full' && !settings.remembered.config, '分析范围记忆没有按功能区分。');
  await api.saveSettings({ ...settings, enabled: true, baseUrl: 'https://example.invalid', model: 'test-model', contextTokens: 4096 });
  for (const feature of ['logs', 'config', 'routes']) {
    const smallContext = await api.previewAi({ feature, scope: 'selection', inputs: [{ text: 'synthetic example' }], fields: [] });
    expect(smallContext.requests === 1 && smallContext.context.userName === 'network_engineer', '最小上下文配置下无法准备请求。');
  }
  await api.saveSettings({ ...settings, enabled: true, baseUrl: 'https://example.invalid', model: 'test-model' });
  const analysisPages = ['配置比对', '路由比对', '日志分析'];
  for (const name of analysisPages) {
    nav(name).click();
    for (let attempt = 0; attempt < 40 && !(document.querySelector('h1')?.textContent === name && document.querySelector('.ai-analysis')); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const analysis = document.querySelector('main > section.panel')?.getBoundingClientRect();
    const ai = document.querySelector('.ai-analysis')?.getBoundingClientRect();
    expect(analysis && ai && Math.abs(analysis.left - ai.left) < 1 && Math.abs(analysis.right - ai.right) < 1, name + '的 AI 模型解读卡片未对齐。');
  }
  const preview = await api.previewAi({ feature: 'config', scope: 'full', inputs: [{ text: 'IpAddress=192.0.2.10, Zone=HQ' }, { text: 'NextHop=192.0.2.10' }],
    fields: [{ name: 'IpAddress' }, { name: 'Zone', replacement: '站点' }, { name: 'NextHop' }] });
  expect(preview.matches.every(field => field.count === 1) && !preview.firstBatch.includes('192.0.2.10') &&
    preview.firstBatch.match(/\[脱敏_1\]/g).length === 2 && preview.firstBatch.includes('Zone=站点'), '跨文本字段值脱敏不一致。');
  expect(preview.skill === '配置变更影响分析' && JSON.parse(preview.evidence).counts.modified === 1 &&
    !preview.evidence.includes('192.0.2.10') && preview.context.userName === 'network_engineer' &&
    preview.context.system.includes('模型负责解释配置语义') && !preview.context.system.includes('192.0.2.10'),
    '配置比对证据、预设角色或系统上下文有误。');
  const logEvidence = await api.previewAi({ feature: 'logs', scope: 'selection', brand,
    inputs: [{ text: '%%01NTP/4/SOURCE_LOST(l)[52]:System synchronization source lost.' }], fields: [] });
  expect(JSON.parse(logEvidence.evidence).entries[0]?.documentedIdentifier === 'NTP/4/NTP_SOURCE_LOST' &&
    JSON.parse(logEvidence.evidence).entries[0]?.meaning, '没有把华为字段库的释义作为可预览证据。');
  const batches = await api.previewAi({ feature: 'logs', scope: 'full', inputs: [{ text: '测'.repeat(8001) }], fields: [] });
  expect(batches.batches === 2 && batches.requests === 3 && batches.firstBatch.length === 8000, '旧设置的兼容预算或汇总请求计数错误。');
  const routeText = heading + '192.0.2.0/24 Static 60 0 D 192.0.2.1 Vlanif10\n Static 60 0 D 192.0.2.2 Vlanif20';
  const routePrivacy = await api.previewAi({ feature: 'routes', scope: 'full', inputs: [{ text: routeText }, { text: routeText }],
    fields: [{ name: 'NextHop' }, { name: 'Destination/Mask' }] });
  expect(routePrivacy.matches[0].count === 4 && routePrivacy.matches[1].count === 2 &&
    !routePrivacy.firstBatch.includes('192.0.2.'), 'IPv4 表格的列值未正确脱敏。');
  const stored = await api.saveSettings({ ...settings, enabled: true, baseUrl: mock.url, model: 'synthetic-model', contextTokens: 100000 },
    { mode: 'replace', value: mock.challenge });
  expect(stored.hasKey && !JSON.stringify(stored).includes(mock.challenge), '设置响应包含明文或未保存共享密钥。');
  const knownEvent = '%%01NTP/4/SOURCE_LOST(l)[52]:System synchronization source lost.\n';
  const wholeInput = { feature: 'logs', scope: 'full', brand,
    inputs: [{ text: knownEvent + '测'.repeat(9000 - knownEvent.length) }], fields: [] };
  const whole = await api.previewAi(wholeInput);
  expect(whole.batches === 1 && whole.requests === 1 && whole.firstBatch === wholeInput.inputs[0].text,
    '模型预算足够时没有预览完整原文。');
  const wholeResult = await api.sendAi(whole.id);
  expect(wholeResult.completed === 1 && wholeResult.citations[0]?.text.includes('SOURCE_LOST'), '全文没有一次发送并绑定原文证据。');
  const outdatedBudget = await api.previewAi(wholeInput);
  await api.saveSettings({ ...stored, contextTokens: 32768 });
  let rejectedBudget = false;
  try { await api.sendAi(outdatedBudget.id); } catch { rejectedBudget = true; }
  expect(rejectedBudget, '修改模型上下文后仍能发送旧预览。');
  const large = await api.previewAi({ feature: 'logs', scope: 'full', inputs: [{ text: '测'.repeat(450000) }], fields: [] });
  expect(large.requests > 17 && large.requests === large.batches + 1, '长材料被固定请求数限制截断。');
  const issue = '%%01NTP/4/SOURCE_LOST(l)[52]:System synchronization source lost. (IpAddress=192.0.2.123)\r\n';
  const recovery = '%%01NTP/4/PEER_SELE(l)[53]:The peer selected by the system is 192.0.2.16.';
  const lastInput = issue + '测'.repeat(8300) + '\r\n' + recovery;
  const last = await api.previewAi({ feature: 'logs', scope: 'full', brand,
    inputs: [{ text: lastInput }], fields: [{ name: 'IpAddress', replacement: '已替换' }] });
  expect(last.batches === 2 && last.requests === 3 && !last.firstBatch.includes('192.0.2.123'), 'AI 发送预览未正确脱敏及分批。');
  const second = await api.aiPreviewBatch(last.id, 1);
  expect(second && last.firstBatch + second === lastInput.replace('192.0.2.123', '已替换'), '分批后预览内容有遗漏。');
  let rejectedStale = false;
  try { await api.sendAi(large.id); } catch { rejectedStale = true; }
  expect(rejectedStale, '过期预览仍可触发发送。');
  const result = await api.sendAi(last.id);
  expect(result.completed === 3 && result.answers.length === 2 && result.report.includes('重新选源') &&
    result.answers[0].text.includes('[证据待核实]') && !result.answers[0].text.includes('L:999999') &&
    result.citations.map(citation => citation.id).join() === 'L:1,L:3,K:1' &&
    result.citations[0].text.includes('IpAddress=已替换') && result.citations[1].text.includes('PEER_SELE') &&
    result.evidenceNotice.includes('1 处引用无法定位') && !result.report.includes('L:999999'),
    '跨批回查、脱敏证据、知识库引用或无效引用处理失败。');
  expect((await api.history()).some(item => item.summary.some(stat => stat.label === 'AI 完成请求' && stat.value === 3)), 'AI 成功任务未记录摘要。');
  const routeAfter = routeText.replace('192.0.2.1 Vlanif10', '192.0.2.11 Vlanif10');
  const routeDraft = await api.previewAi({ feature: 'routes', scope: 'full', inputs: [{ text: routeText }, { text: routeAfter }],
    fields: [{ name: 'NextHop' }, { name: 'Destination/Mask' }] });
  const aiRoute = await api.sendAi(routeDraft.id);
  expect(aiRoute.completed === 1 && aiRoute.citations.map(citation => citation.id).join() === 'B:5,A:5' &&
    aiRoute.citations[0].text.includes('[脱敏_') && aiRoute.citations[0].text !== aiRoute.citations[1].text,
    '路由前后快照证据映射或脱敏失败。');
  nav('配置比对').click();
  await waitFor(() => document.querySelector('textarea[aria-label="变更后"]') && document.querySelector('.ai-analysis select'), '配置 AI 面板未显示。');
  enter('textarea[aria-label="变更前"]', '#\r\ninterface Vlanif10\r\n description OLD\r\n', HTMLTextAreaElement);
  enter('textarea[aria-label="变更后"]', '#\r\ninterface Vlanif10\r\n description NEW\r\n', HTMLTextAreaElement);
  const scopeSelect = document.querySelector('.ai-analysis select');
  scopeSelect.value = 'full';
  scopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => !findButton('.ai-analysis button', '本地预览')?.disabled, '配置 AI 全文分析无法预览。');
  findButton('.ai-analysis button', '本地预览').click();
  await waitFor(() => document.querySelector('.ai-preview input[type="checkbox"]'), '配置 AI 发送确认未出现。');
  expect(document.querySelector('.ai-preview details')?.textContent.includes('network_engineer'), '预览未显示 API 的预设上下文。');
  document.querySelector('.ai-preview input[type="checkbox"]').click();
  await waitFor(() => !findButton('.ai-analysis button', '发送')?.disabled, '配置 AI 确认未生效。');
  findButton('.ai-analysis button', '发送').click();
  await waitFor(() => document.querySelector('.ai-citation[aria-label="查看证据 A:3"]'), '配置 AI 报告未显示可点击的证据。');
  document.querySelector('.ai-citation[aria-label="查看证据 A:3"]').click();
  await waitFor(() => document.querySelector('.ai-citation-detail')?.textContent.includes('description NEW'), '点击引用未定位到变更后配置第 3 行。');
  const tooLargeForApi = await api.previewAi({ feature: 'logs', scope: 'selection', inputs: [{ text: 'SYNTHETIC_CONTEXT_LIMIT' }], fields: [] });
  const failure = await api.sendAi(tooLargeForApi.id);
  expect(failure.completed === 0 && failure.notice.includes('调低预算后重新预览'), '接口上下文错误没有提示重新预览。');
  await api.saveSettings({ ...settings, enabled: false, baseUrl: '', model: '' }, { mode: 'clear' });
  return { ready: true, name: document.title, knowledgeRules: knowledge.rows.length, cliMatches: cli.total, ipcChecksPassed: true, alignedAiPages: analysisPages.length, batchRuleChoices: true, ruleDocumentSources: true };
}
