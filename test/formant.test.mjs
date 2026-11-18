import test from 'node:test';
import assert from 'node:assert/strict';
import { MixEngine } from '../src/renderer/dsp/dsp.mjs';
const SR=44100, SECS=6, n=SR*SECS;
// vocal sintética: tren de pulsos a f0 filtrado por 3 formantes (vocal "a")
function synth(f0, F=[700,1200,2600], bw=[90,110,170]){
  const x=new Float32Array(n); let ph=0;
  const y=[0,0,0],y1=[0,0,0],y2=[0,0,0];
  const co=F.map((f,i)=>{const r=Math.exp(-Math.PI*bw[i]/SR);return {a1:-2*r*Math.cos(2*Math.PI*f/SR),a2:r*r}});
  for(let i=0;i<n;i++){
    ph+=f0/SR; let e=0; if(ph>=1){ph-=1;e=1;}
    let s=0;
    for(let k=0;k<3;k++){ const c=co[k]; const o=e*(1-c.a2)*0.3 - c.a1*y1[k] - c.a2*y2[k]; y2[k]=y1[k]; y1[k]=o; s+=o; }
    x[i]=s;
  }
  return x;
}
function render(vocalFlag, semis){
  const x=synth(200); const e=new MixEngine([{l:x,r:x.slice()}], [vocalFlag]); e.setSemitones(semis);
  const L=new Float32Array(4096),R=new Float32Array(4096); const out=[];
  for(;;){const g=e.render(L,R,4096); if(!g)break; out.push(L.slice(0,g));}
  const t=out.reduce((s,c)=>s+c.length,0), all=new Float32Array(t); let o=0; for(const c of out){all.set(c,o);o+=c.length}
  return all;
}
// envolvente cepstral (log, dB) sobre ventana larga
function envDb(buf){
  const a=Math.floor(buf.length*0.4), M=8192; const x=new Float64Array(M);
  for(let i=0;i<M;i++) x[i]=buf[a+i]*(0.5-0.5*Math.cos(2*Math.PI*i/M));
  const re=new Float64Array(M), im=new Float64Array(M);
  const dft=(inRe,inIm,inv)=>{ // FFT simple recursiva O(n log n) vía iterativa
    const n=inRe.length; const R=Float64Array.from(inRe), I=Float64Array.from(inIm);
    for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[R[i],R[j]]=[R[j],R[i]];[I[i],I[j]]=[I[j],I[i]];}}
    for(let len=2;len<=n;len<<=1){const ang=2*Math.PI/len*(inv?1:-1);for(let i=0;i<n;i+=len)for(let k=0;k<len/2;k++){const wr=Math.cos(ang*k),wi=Math.sin(ang*k);const a=i+k,b=a+len/2;const xr=R[b]*wr-I[b]*wi,xi=R[b]*wi+I[b]*wr;R[b]=R[a]-xr;I[b]=I[a]-xi;R[a]+=xr;I[a]+=xi;}}
    if(inv)for(let i=0;i<n;i++){R[i]/=n;I[i]/=n;}
    return [R,I];
  };
  const [Xr,Xi]=dft(x,new Float64Array(M),false);
  const lm=new Float64Array(M); for(let k=0;k<M;k++) lm[k]=Math.log(Math.hypot(Xr[k],Xi[k])+1e-9);
  const [Cr]=dft(lm,new Float64Array(M),true);
  const L=new Float64Array(M); const lift=60; L[0]=Cr[0]; for(let q=1;q<lift;q++){L[q]=Cr[q];L[M-q]=Cr[q];}
  const [Er]=dft(L,new Float64Array(M),false);
  const out=[]; for(let f=150;f<=5000;f+=25){out.push([f,Er[Math.round(f/SR*M)]*8.686]);} return out;
}
const peaks=e=>{const p=[];for(let i=1;i<e.length-1;i++)if(e[i][1]>e[i-1][1]&&e[i][1]>e[i+1][1]&&e[i][1]>Math.max(...e.map(v=>v[1]))-25)p.push(e[i][0]);return p.slice(0,3)};
const norm=e=>{const m=e.reduce((s,v)=>s+v[1],0)/e.length;return e.map(v=>[v[0],v[1]-m])};
const dist=(a,b)=>Math.sqrt(a.reduce((s,v,i)=>s+(v[1]-b[i][1])**2,0)/a.length);

test('con corrección de formantes el timbre de la voz se parece más al original', () => {
  const eo = norm(envDb(render(false, 0)));
  for (const st of [5, -5]) {
    const sin = dist(eo, norm(envDb(render(false, st))));
    const con = dist(eo, norm(envDb(render(true, st))));
    assert.ok(con < sin * 0.6, `${st} st: sin corrección ${sin.toFixed(1)} dB, con corrección ${con.toFixed(1)} dB`);
  }
});

test('sin cambio de tono las pistas de voz no se tocan', () => {
  const a = render(false, 0), b = render(true, 0);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 997) assert.equal(a[i], b[i]);
});
