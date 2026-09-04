import React,{useEffect,useMemo,useState} from "react";
import {createRoot} from "react-dom/client";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./styles.css";

const DEFAULT={lat:19.917,lon:99.215,name:"ฝาง, เชียงใหม่"};
const MODEL_API="https://api.open-meteo.com/v1/forecast";

function fmt(ts){return new Intl.DateTimeFormat("th-TH",{hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(ts*1000))}
function median(a){const b=a.filter(Number.isFinite).sort((x,y)=>x-y); if(!b.length)return 0; const m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2}
function risk(mm){if(mm>=10)return ["หนัก","danger"];if(mm>=2)return ["ปานกลาง","warn"];if(mm>0.1)return ["เล็กน้อย","light"];return ["ไม่มี/ต่ำ","dry"]}

function App(){
 const [map,setMap]=useState(null),[frames,setFrames]=useState([]),[idx,setIdx]=useState(-1);
 const [layer,setLayer]=useState(null),[loc,setLoc]=useState(DEFAULT),[loading,setLoading]=useState(true);
 const [playing,setPlaying]=useState(false),[models,setModels]=useState(null),[updated,setUpdated]=useState(null);
 const [source,setSource]=useState("rainviewer"),[err,setErr]=useState("");

 useEffect(()=>{const m=L.map("map",{zoomControl:false}).setView([DEFAULT.lat,DEFAULT.lon],8);
  L.control.zoom({position:"bottomright"}).addTo(m);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(m);
  setMap(m); return()=>m.remove()},[]);

 async function radar(){
  setLoading(true);setErr("");
  try{
   const r=await fetch("https://api.rainviewer.com/public/weather-maps.json",{cache:"no-store"});
   if(!r.ok)throw Error();
   const d=await r.json(); const past=d?.radar?.past||[];
   setFrames(past);setIdx(Math.max(0,past.length-1));setUpdated(Date.now());
  }catch{setErr("โหลด RainViewer ไม่สำเร็จ")}
  finally{setLoading(false)}
 }
 async function forecast(lat=loc.lat,lon=loc.lon){
  try{
   // Three independent global model products via Open-Meteo.
   // We keep them separate so the UI can expose disagreement instead of hiding it.
   const specs=[
    ["ECMWF IFS","ecmwf_ifs025"],
    ["NOAA GFS","gfs_seamless"],
    ["DWD ICON","icon_seamless"]
   ];
   const out=await Promise.all(specs.map(async([name,model])=>{
    const u=`${MODEL_API}?latitude=${lat}&longitude=${lon}&hourly=rain,precipitation,precipitation_probability&forecast_hours=3&timezone=auto&models=${model}`;
    const d=await (await fetch(u)).json();
    return {name,time:d.hourly.time,rain:d.hourly.rain||d.hourly.precipitation,prob:d.hourly.precipitation_probability||[]};
   }));
   setModels(out);
  }catch{setModels(null)}
 }
 useEffect(()=>{radar();forecast()},[]);
 useEffect(()=>{if(!map||idx<0||!frames[idx])return;
  if(layer)layer.remove();
  const f=frames[idx],url=`https://tilecache.rainviewer.com${f.path}/256/{z}/{x}/{y}/2/1_1.png`;
  const l=L.tileLayer(url,{opacity:.75,maxZoom:7,attribution:"Radar: RainViewer"}).addTo(map);setLayer(l);
 },[map,idx,frames]);
 useEffect(()=>{if(!playing||frames.length<2)return;const id=setInterval(()=>setIdx(i=>{if(i>=frames.length-1){setPlaying(false);return i}return i+1}),650);return()=>clearInterval(id)},[playing,frames.length]);

 function locate(){navigator.geolocation?.getCurrentPosition(p=>{const n={lat:p.coords.latitude,lon:p.coords.longitude,name:"ตำแหน่งของฉัน"};setLoc(n);map?.setView([n.lat,n.lon],10);forecast(n.lat,n.lon)})}

 const consensus=useMemo(()=>{
  if(!models?.length)return [];
  const len=Math.min(...models.map(x=>x.rain.length),3);
  return Array.from({length:len},(_,i)=>{
   const vals=models.map(x=>Number(x.rain[i]||0));
   const probs=models.map(x=>Number(x.prob[i]||0));
   return {time:new Date(models[0].time[i]).getTime(),mm:median(vals),prob:Math.round(median(probs)),spread:Math.max(...vals)-Math.min(...vals)};
  });
 },[models]);
 const total=consensus.reduce((s,x)=>s+x.mm,0), status=risk(total);

 return <div className="app">
  <header><div><div className="brand">🌧️ SHEN RAIN RADAR</div><div className="sub">{loc.name}</div></div>
   <button onClick={locate}>📍</button></header>

  <div className="sourcebar">
   <button className={source==="rainviewer"?"active":""} onClick={()=>setSource("rainviewer")}>Radar</button>
   <button className={source==="tmd"?"active":""} onClick={()=>setSource("tmd")}>TMD</button>
   <button onClick={()=>{radar();forecast()}}>↻ อัปเดต</button>
  </div>

  <main><div id="map"></div><div className="status">{loading?"กำลังโหลด…":idx>=0?`Radar ${fmt(frames[idx].time)}`:"ไม่มีข้อมูล"}</div>
   <div className="legend">🟦 ฝนอ่อน　🟨 ปานกลาง　🟥 ฝนหนัก</div>
  </main>

  {source==="tmd"&&<section className="notice">
   <b>ข้อมูลเรดาร์ TMD</b>
   <p>กรมอุตุนิยมวิทยามีเรดาร์หลายสถานี รวมถึงแม่ฮ่องสอน เชียงราย ลำพูน และดอยมูเซอ ซึ่งเหมาะกับภาคเหนือ แต่รูปแบบข้อมูลของ TMD ยังต้องทำ adapter แยกก่อนนำมาซ้อนเป็น tile เดียวกับแผนที่</p>
  </section>}

  <section className="panel"><div className="title">Radar ย้อนหลัง</div>
   <input type="range" min="0" max={Math.max(0,frames.length-1)} value={Math.max(0,idx)} onChange={e=>setIdx(+e.target.value)}/>
   <div className="times"><span>{frames[0]?fmt(frames[0].time):"--:--"}</span><strong>{frames[idx]?fmt(frames[idx].time):"--:--"}</strong><span>{frames.at(-1)?fmt(frames.at(-1).time):"--:--"}</span></div>
   <button className="play" onClick={()=>setPlaying(x=>!x)}>{playing?"⏸ หยุด":"▶ เล่น Animation"}</button>
  </section>

  <section className="forecast">
   <div className="title">แนวโน้มฝน 2 ชั่วโมงข้างหน้า</div>
   <div className="big">{models?`${status[0]} · median ${total.toFixed(1)} mm`:"กำลังโหลด…"}</div>
   <div className="grid">{consensus.map((x,i)=><div className="hour" key={i}><b>{fmt(x.time/1000)}</b><span>{x.mm.toFixed(1)} mm</span><small>โอกาส {x.prob}%</small></div>)}</div>
   {models&&<div className="modelnote">ใช้ ECMWF + NOAA GFS + DWD ICON แล้วแสดงค่ากลาง (median) พร้อมความต่างระหว่างโมเดล ไม่ใช่การรับรองความแม่นยำ</div>}
  </section>

  <footer>{err&&<span className="error">{err}</span>}<span>Radar: RainViewer · TMD · Forecast models: ECMWF / GFS / ICON via Open-Meteo</span></footer>
 </div>
}
createRoot(document.getElementById("root")).render(<App/>);