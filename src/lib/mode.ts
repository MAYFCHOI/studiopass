/** `vite build --mode demo` (.env.demo) 이면 브라우저 저장소 + 가짜 데이터, 아니면 서버 API. */
export const IS_DEMO = import.meta.env.VITE_MODE === 'demo';
