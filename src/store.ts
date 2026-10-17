import { createDemoStore } from './store/demo';

export type { ScanResult, Store } from './types';
export { passFits } from './lib/passes';

export const useStore = createDemoStore();
