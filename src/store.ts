import { createDemoStore } from './store/demo';
import { createRemoteStore } from './store/remote';

export type { ScanResult, Store } from './types';
export { passFits } from './lib/passes';

// 모드는 빌드 때 정해진다(import.meta.env 를 직접 비교해야 쓰지 않는 쪽이 번들에서 빠진다).
export const useStore = import.meta.env.VITE_MODE === 'demo' ? createDemoStore() : createRemoteStore();
