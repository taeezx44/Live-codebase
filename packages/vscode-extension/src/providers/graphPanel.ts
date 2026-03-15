// ============================================================
// providers/graphPanel.ts  —  Sidebar webview panel
//
// Renders a mini dependency graph using Sigma.js (loaded via CDN).
// Messages sent to the webview:
//   { type: "graphData",  data: GraphData }
//   { type: "highlight",  filePath: string }
//   { type: "showImpact", filePath: string, affected: string[] }
//
// Messages received from the webview:
//   { type: "openFile",   filePath: string }
//   { type: "ready" }
// ============================================================

import * as vscode from "vscode";
import type { CodeVisClient, GraphData } from "../client.js";

export class GraphPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentRepoId?: string;
  private graphData?: GraphData;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: CodeVisClient
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready": {
          // Webview just loaded — send graph data if we have it
          if (this.graphData) {
            this.postMessage({ type: "graphData", data: this.graphData });
          } else {
            await this.loadGraph();
          }
          break;
        }
        case "openFile": {
          const uri = vscode.Uri.file(msg.filePath as string);
          await vscode.window.showTextDocument(uri, {
            preview: true,
            preserveFocus: false,
          });
          break;
        }
      }
    });
  }

  // ── Public API (called by extension.ts commands) ────────────

  highlightFile(filePath: string): void {
    this.postMessage({ type: "highlight", filePath });
  }

  async showImpact(filePath: string): Promise<void> {
    if (!this.currentRepoId) return;
    const impact = await this.client.getImpact(this.currentRepoId, filePath);
    if (!impact) {
      vscode.window.showWarningMessage(
        `CodeVis: no impact data for ${filePath.split("/").at(-1)}`
      );
      return;
    }
    this.postMessage({
      type:     "showImpact",
      filePath,
      affected: impact.affectedFiles.map((f) => f.path),
    });
  }

  async setRepo(repoId: string): Promise<void> {
    this.currentRepoId = repoId;
    await this.loadGraph();
  }

  // ── Internals ────────────────────────────────────────────────

  private async loadGraph(): Promise<void> {
    if (!this.currentRepoId) {
      // Try to auto-detect repo from workspace
      const repos = await this.client.listRepos();
      if (repos.length === 0) {
        this.postMessage({ type: "noData" });
        return;
      }
      this.currentRepoId = repos[0].repoId;
    }

    const data = await this.client.getGraph(this.currentRepoId);
    if (!data) {
      this.postMessage({ type: "error", message: "Could not load graph data." });
      return;
    }
    this.graphData = data;
    this.postMessage({ type: "graphData", data });
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  // ── Webview HTML ─────────────────────────────────────────────

  private getHtml(): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           script-src 'unsafe-inline' https://cdn.jsdelivr.net;
           style-src 'unsafe-inline';
           connect-src http://localhost:*;">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#1e1e1e;color:#ccc;font-family:var(--vscode-font-family);font-size:12px;overflow:hidden;height:100vh;display:flex;flex-direction:column}
  #toolbar{padding:6px 8px;display:flex;align-items:center;gap:6px;border-bottom:1px solid #333;flex-shrink:0}
  #toolbar input{flex:1;background:#2d2d2d;border:1px solid #444;color:#ccc;border-radius:3px;padding:3px 6px;font-size:11px;outline:none}
  #toolbar input:focus{border-color:#0e639c}
  #canvas-wrap{flex:1;position:relative}
  #graph-canvas{width:100%;height:100%}
  #status{position:absolute;bottom:6px;left:8px;font-size:10px;color:#666}
  #no-data{display:none;flex:1;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:#666;text-align:center;padding:20px}
  #no-data.show{display:flex}
  .btn{background:#0e639c;border:none;color:#fff;padding:5px 10px;border-radius:3px;cursor:pointer;font-size:11px}
  .btn:hover{background:#1177bb}
</style>
</head>
<body>
<div id="toolbar">
  <input id="search" placeholder="Search files…" oninput="onSearch(this.value)"/>
</div>
<div id="canvas-wrap">
  <canvas id="graph-canvas"></canvas>
  <div id="status">Loading…</div>
</div>
<div id="no-data">
  <div>No graph data</div>
  <div style="font-size:10px">Run an analysis from the CodeVis dashboard first</div>
</div>

<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('graph-canvas');
const ctx = canvas.getContext('2d');
const status = document.getElementById('status');

const LANG_COLORS = {ts:'#3b82f6',js:'#f59e0b',py:'#10b981',go:'#06b6d4',unknown:'#6b7280'};
let nodes=[], edges=[], selectedFile=null, highlightFile=null, impactFiles=new Set();
let camX=0, camY=0, scale=1, drag=false, lmx=0, lmy=0, mx=0, my=0;
let animId=null;

function resize() {
  const wrap = document.getElementById('canvas-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}
window.addEventListener('resize', resize);
resize();

// Coordinate helpers
const w2s = (wx,wy)=>[(wx+camX)*scale+canvas.width/2,(wy+camY)*scale+canvas.height/2];
const s2w = (sx,sy)=>[(sx-canvas.width/2)/scale-camX,(sy-canvas.height/2)/scale-camY];

function layout() {
  // Simple force-directed layout (quick spring)
  for(let i=0;i<200;i++){
    nodes.forEach(n=>{n.vx=(n.vx||0)*0.8;n.vy=(n.vy||0)*0.8});
    for(let a=0;a<nodes.length;a++) for(let b=a+1;b<nodes.length;b++){
      const na=nodes[a],nb=nodes[b];
      const dx=nb.x-na.x,dy=nb.y-na.y,d=Math.sqrt(dx*dx+dy*dy)||1;
      const f=800/(d*d);
      na.vx-=dx/d*f;na.vy-=dy/d*f;nb.vx+=dx/d*f;nb.vy+=dy/d*f;
    }
    edges.forEach(e=>{
      const a=nodes.find(n=>n.id===e.source),b=nodes.find(n=>n.id===e.target);
      if(!a||!b)return;
      const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1;
      const f=(d-60)*0.012;
      a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f;
    });
    nodes.forEach(n=>{n.vx-=n.x*0.003;n.vy-=n.y*0.003;n.x+=n.vx;n.y+=n.vy});
  }
}

function draw() {
  animId=requestAnimationFrame(draw);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#1e1e1e';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  if(!nodes.length) return;

  const hov = getNodeAt(mx,my);

  edges.forEach(e=>{
    const a=nodes.find(n=>n.id===e.source),b=nodes.find(n=>n.id===e.target);
    if(!a||!b)return;
    const [ax,ay]=w2s(a.x,a.y),[bx,by]=w2s(b.x,b.y);
    const lit=(hov&&(hov.id===e.source||hov.id===e.target))
      ||(highlightFile&&(e.source===highlightFile||e.target===highlightFile))
      ||impactFiles.has(e.source)||impactFiles.has(e.target);
    ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);
    ctx.strokeStyle=lit?'#0e639c55':'#333';
    ctx.lineWidth=lit?1.5:0.5;
    ctx.stroke();
  });

  nodes.forEach(n=>{
    const [sx,sy]=w2s(n.x,n.y);
    const r=Math.max(3,Math.sqrt(n.loc||50)*0.8)*scale;
    if(sx<-r||sx>canvas.width+r||sy<-r||sy>canvas.height+r)return;
    const isHL=n.id===highlightFile;
    const isImpact=impactFiles.has(n.id);
    const isHov=hov?.id===n.id;
    const col=LANG_COLORS[n.language]||'#6b7280';
    ctx.beginPath();
    ctx.arc(sx,sy,isHL?r*1.5:r,0,Math.PI*2);
    ctx.fillStyle=isHL?'#fff':isImpact?'#f97316bb':col+'aa';
    ctx.fill();
    if(isHL||isHov){ctx.strokeStyle=isHL?'#fff':col;ctx.lineWidth=1.5;ctx.stroke();}
    if(scale>0.8){
      ctx.font=\`\${Math.round(9*scale)}px monospace\`;
      ctx.fillStyle=isHL?'#fff':isHov?'#ccc':'#555';
      ctx.textAlign='center';
      const label=n.id.split('/').at(-1)||n.id;
      ctx.fillText(label,sx,sy+r+9*scale);
    }
  });
}

function getNodeAt(mx,my){
  const [wx,wy]=s2w(mx,my);
  for(let i=nodes.length-1;i>=0;i--){
    const n=nodes[i];
    const r=Math.max(3,Math.sqrt(n.loc||50)*0.8)+4;
    const dx=n.x-wx,dy=n.y-wy;
    if(dx*dx+dy*dy<r*r)return n;
  }
  return null;
}

canvas.onmousedown=e=>{drag=true;lmx=e.offsetX;lmy=e.offsetY};
canvas.onmousemove=e=>{
  mx=e.offsetX;my=e.offsetY;
  if(drag){camX+=(e.offsetX-lmx)/scale;camY+=(e.offsetY-lmy)/scale;lmx=e.offsetX;lmy=e.offsetY;}
  canvas.style.cursor=getNodeAt(e.offsetX,e.offsetY)?'pointer':drag?'grabbing':'grab';
};
canvas.onmouseup=()=>drag=false;
canvas.onclick=e=>{
  if(Math.abs(e.movementX)+Math.abs(e.movementY)>3)return;
  const n=getNodeAt(e.offsetX,e.offsetY);
  if(n){selectedFile=n.id;vscode.postMessage({type:'openFile',filePath:n.id});}
};
canvas.onwheel=e=>{
  e.preventDefault();
  const f=e.deltaY<0?1.1:0.9;
  const [wx,wy]=s2w(e.offsetX,e.offsetY);
  scale=Math.max(0.1,Math.min(5,scale*f));
  const [nx,ny]=w2s(wx,wy);
  camX+=(e.offsetX-nx)/scale;camY+=(e.offsetY-ny)/scale;
};

function onSearch(q){
  q=q.toLowerCase();
  nodes.forEach(n=>n._hidden=q&&!n.id.toLowerCase().includes(q));
}

// Messages from extension
window.addEventListener('message',e=>{
  const msg=e.data;
  switch(msg.type){
    case 'graphData': {
      nodes=msg.data.nodes.map(n=>({...n,x:(Math.random()-.5)*300,y:(Math.random()-.5)*300,vx:0,vy:0}));
      edges=msg.data.edges;
      layout();
      document.getElementById('no-data').classList.remove('show');
      status.textContent=nodes.length+' files · '+edges.length+' edges';
      break;
    }
    case 'highlight': {
      highlightFile=msg.filePath;
      impactFiles.clear();
      // Pan to node
      const n=nodes.find(nd=>nd.id===msg.filePath||nd.id.endsWith(msg.filePath.replace(/\\\\/g,'/')));
      if(n){
        const steps=20,tx=-n.x,ty=-n.y;
        const dx=(tx-camX)/steps,dy=(ty-camY)/steps;
        let i=0;
        function step(){if(i++<steps){camX+=dx;camY+=dy;requestAnimationFrame(step);}}
        step();
      }
      break;
    }
    case 'showImpact': {
      highlightFile=msg.filePath;
      impactFiles=new Set(msg.affected);
      status.textContent=msg.affected.length+' files affected';
      break;
    }
    case 'noData':
      document.getElementById('no-data').classList.add('show');
      status.textContent='';
      break;
    case 'error':
      status.textContent=msg.message;
      break;
  }
});

// Start
if(!animId) animId=requestAnimationFrame(draw);
vscode.postMessage({type:'ready'});
</script>
</body>
</html>`;
  }
}
