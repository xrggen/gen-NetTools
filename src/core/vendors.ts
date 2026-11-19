import { scanHuaweiLogs } from './logs';
import { collectHuaweiRules } from './huawei-rules';
import { compareRoutes } from './routes';

// Vendor adapters share the normalized contracts, storage, task worker and renderer.
const adapters = new Map([['Huawei', { scanLogs: scanHuaweiLogs, collectRules: collectHuaweiRules, compareRoutes }]]);

export function vendorAdapter(vendor: string) {
  const adapter = adapters.get(vendor);
  if (!adapter) throw new Error('这个厂商的解析适配还未提供。');
  return adapter;
}
