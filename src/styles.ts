export const styles = `
:host { all: initial; font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #172b4d; color-scheme: light; }
* { box-sizing: border-box; } [hidden] { display: none !important; }
button,input,textarea,select { font: inherit; } button { cursor: pointer; border: 1px solid #ced7e3; border-radius: 5px; background: #f7f9fc; color: #172b4d; padding: 8px 12px; }
button:hover { background: #edf2f7; } button:disabled { cursor: wait; opacity: .6; }
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,a:focus-visible { outline: 2px solid #0d9488; outline-offset: 2px; }
.launcher { position: fixed; right: 0; top: 50%; transform: translateY(-50%); background: #0d9488; color: white; border: 0; border-radius: 24px 0 0 24px; padding: 13px 18px; font-weight: 650; box-shadow: 0 6px 24px #172b4d33; }
.launcher:hover,.primary:hover { background: #0b7b72; }
.panel { position: fixed; top: 18px; right: 18px; bottom: 18px; width: 540px; max-width: calc(100vw - 36px); background: #fff; border: 1px solid #dce3ed; border-radius: 9px; box-shadow: 0 14px 65px #172b4d38; display: flex; flex-direction: column; overflow: hidden; }
header { padding: 16px 22px 12px; display: flex; justify-content: space-between; align-items: flex-start; }
h1 { font-size: 23px; line-height: 1.3; margin: 0; letter-spacing: -.6px; } h2 { margin: 22px 0 14px; font-size: 18px; } p { margin: 4px 0 14px; } .muted,small { color: #62758d; } small { font-size: 12px; }
.close { background: none; border: 0; font-size: 23px; padding: 0 3px; }
nav { display: flex; padding: 0 22px; border-bottom: 1px solid #dce3ed; } nav button { flex: 1; border: 0; border-radius: 0; background: #fff; padding: 11px 4px; border-bottom: 2px solid transparent; }
nav button[aria-selected=true] { color: #0d9488; border-bottom-color: #0d9488; font-weight: 650; }
main { padding: 12px 22px 20px; overflow-y: auto; overscroll-behavior: contain; flex: 1; }
.status { margin: 0 22px 10px; padding: 9px 12px; border-radius: 5px; background: #e8f6f3; color: #156a54; white-space: pre-line; overflow-wrap: anywhere; } .status:empty { display: none; } .status.error { background: #fff0ed; color: #a73525; }
.row { display: flex; gap: 10px; align-items: center; } .row > input,.row > label { flex: 1; min-width: 0; } .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; } .grid > label { min-width: 0; }
label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 13px; } input,textarea,select { display: block; width: 100%; margin-top: 5px; border: 1px solid #bac7d8; border-radius: 4px; padding: 9px 11px; background: #fff; color: #172b4d; font-weight: 400; min-height: 40px; } input[type=checkbox] { display: inline; width: auto; min-height: 0; margin: 0 6px 0 0; } textarea { resize: vertical; min-height: 64px; } .check { font-weight: 400; }
.primary { background: #0d9488; border-color: #0d9488; color: white; font-weight: 600; } .wide { width: 100%; } .danger { color: #b42318; } .small { font-size: 12px; padding: 4px 8px; }
.summary { margin: 10px 0 12px; line-height: 1.7; } .summary strong { font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: 13px; } th { background: #f4f6fa; font-weight: 600; text-align: left; } th,td { padding: 10px 8px; border-bottom: 1px solid #dce3ed; vertical-align: top; } a { color: #1264a3; text-decoration: none; } a:hover { text-decoration: underline; } td p { margin: 4px 0; overflow-wrap: anywhere; font-size: 12px; } .nowrap { white-space: nowrap; } .empty { color: #62758d; padding: 20px 0; }
hr { border: 0; border-top: 1px solid #dce3ed; margin: 22px 0 0; } .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; } .tracker { padding: 15px 0; border-bottom: 1px solid #dce3ed; } .tracker-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; } .tracker-title strong { font-size: 16px; } details { margin-top: 8px; } summary { cursor: pointer; color: #62758d; }
@media(max-width: 560px) { .panel { inset: 0; width: 100%; max-width: 100%; border-radius: 0; } header { padding: 16px; } nav { padding: 0 12px; } main { padding: 16px; } .status { margin: 0 16px 8px; } .grid { gap: 10px; } th,td { padding: 8px 5px; } }
`
