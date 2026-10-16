// Prompt files are bundled as text (wrangler.jsonc "rules").
declare module '*.md' {
  const text: string;
  export default text;
}
