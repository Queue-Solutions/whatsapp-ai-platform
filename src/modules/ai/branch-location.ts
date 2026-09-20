/** Location data is resolved independently of the language model. */
export interface Point {latitude:number;longitude:number}
export interface Area extends Point {label:string}
export interface LocationResolver {
  pin(text:string):Promise<Point|null>;
  area(text:string,branches:Point[]):Promise<Area|null>;
}
export function point(latitude:unknown,longitude:unknown):Point|null {
  if(latitude==null||longitude==null||String(latitude).trim()===''||String(longitude).trim()==='')return null;
  const lat=Number(latitude),lon=Number(longitude);
  return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180?{latitude:lat,longitude:lon}:null;
}
function googleMap(text:string):URL|null {
  try{const u=new URL(text);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(
    u.hostname==='maps.app.goo.gl'||(u.hostname==='goo.gl'&&u.pathname.startsWith('/maps'))||
    u.hostname==='maps.google.com'||(['google.com','www.google.com'].includes(u.hostname)&&u.pathname.startsWith('/maps')))?u:null;}catch{return null;}
}
export function coordinates(text:string):Point|null {
  const pair=(s:string)=>{const m=s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);return m?point(m[1],m[2]):null;};
  if(text.startsWith('geo:'))return pair(text.slice(4));
  const literal=pair(text);if(literal)return literal;
  const url=googleMap(text);if(!url)return null;
  // Place coordinates precede map viewport coordinates. @lat,lon is only the camera, not a pin.
  let decoded:string;try{decoded=decodeURIComponent(url.href);}catch{return null;}
  const place=decoded.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if(place)return point(place[1],place[2]);
  for(const key of ['q','query']){const p=pair(url.searchParams.get(key)??'');if(p)return p;}
  return null;
}
export function distanceKm(a:Point,b:Point){
  const r=Math.PI/180,dLat=(b.latitude-a.latitude)*r,dLon=(b.longitude-a.longitude)*r;
  const h=Math.sin(dLat/2)**2+Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin(dLon/2)**2;
  return 6371*2*Math.asin(Math.sqrt(Math.min(1,h)));
}
const areaKey=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[إأآ]/g,'ا').replace(/ة/g,'ه')
  .replace(/\b(?:city|town|district|al|el)\b|مدينه|مدينة/g,' ').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export class GeoLocations implements LocationResolver {
  private areas=new Map<string,{expires:number;area:Area|null}>();
  private cache=new Map<string,{expires:number;point:Point|null}>();
  constructor(private fetcher:typeof fetch=fetch,private endpoint=process.env.GEOCODER_URL??'https://photon.komoot.io/api/'){}
  async pin(text:string):Promise<Point|null>{
    try{
      const direct=coordinates(text);if(direct)return direct;
      let url=googleMap(text);if(!url)return null;
      const saved=this.cache.get(text);if(saved&&saved.expires>Date.now())return saved.point;
      const signal=AbortSignal.timeout(5000);let result:Point|null=null;
      for(let i=0;i<4;i++){
        const response=await this.fetcher(url,{redirect:'manual',signal});
        await response.body?.cancel();
        const next=response.headers.get('location');if(!next||response.status<300||response.status>=400)break;
        url=googleMap(new URL(next,url).href);if(!url)break;
        result=coordinates(url.href);if(result)break;
      }
      if(this.cache.size>=256)this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(text,{point:result,expires:Date.now()+(result?86400000:60000)});
      return result;
    }catch{return null;}
  }
  async area(text:string,branches:Point[]):Promise<Area|null>{
    // An unresolved pin/link must never become a third-party city-search query.
    if(/https?:|geo:|@|[-+]?\d+\.\d+\s*,/i.test(text)||!/[\p{L}]/u.test(text))return null;
    const query=areaKey(text);if(query.length<2||query.length>100||!branches.length)return null;
    try{
      const url=new URL(this.endpoint);if(url.protocol!=='https:')return null;
      url.searchParams.set('q',query);url.searchParams.set('limit','5');
      if(!/[\u0600-\u06ff]/.test(query))url.searchParams.set('lang','en');
      for(const tag of ['place:city','place:town','place:suburb','place:village'])url.searchParams.append('osm_tag',tag);
      const lats=branches.map(p=>p.latitude),lons=branches.map(p=>p.longitude);
      url.searchParams.set('bbox',[Math.max(-180,Math.min(...lons)-2),Math.max(-90,Math.min(...lats)-2),Math.min(180,Math.max(...lons)+2),Math.min(90,Math.max(...lats)+2)].join(','));
      const cacheKey=url.href,saved=this.areas.get(cacheKey);
      if(saved&&saved.expires>Date.now())return saved.area;
      const response=await this.fetcher(url,{redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!response.ok||!response.body)return null;
      const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
      try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>65536)return null;chunks.push(value);}}finally{await reader.cancel();}
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!Array.isArray(data.features))return null;
      const found:Area[]=[];
      for(const feature of data.features.slice(0,5)){
        const name=feature?.properties?.name,geo=feature?.geometry;
        if(typeof name!=='string'||name.length>100||geo?.type!=='Point'||!Array.isArray(geo.coordinates))continue;
        if(!['city','town','village','suburb','district','locality'].includes(feature.properties.type))continue;
        if(areaKey(name)!==query)continue; // Never substitute a similarly named business or city.
        const p=point(geo.coordinates[1],geo.coordinates[0]);
        if(p&&p.latitude>=Math.min(...lats)-2&&p.latitude<=Math.max(...lats)+2&&p.longitude>=Math.min(...lons)-2&&p.longitude<=Math.max(...lons)+2&&!found.some(a=>distanceKm(a,p)<1))found.push({...p,label:name});
      }
      const result=found.length===1?found[0]:null;
      if(this.areas.size>=256)this.areas.delete(this.areas.keys().next().value!);
      this.areas.set(cacheKey,{area:result,expires:Date.now()+(result?900000:60000)});
      return result;
    }catch{return null;}
  }
}
