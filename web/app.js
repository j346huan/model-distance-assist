import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { viewBasis, projectedBounds, measurePoint, measureWallPoint, centeredGridPositions, normalizeDegrees } from './measurements.js';

const $ = id => document.getElementById(id);
const $$ = selector => document.querySelectorAll(selector);
const dimensionIds = ['box-width','box-depth','box-height'];
const sides = ['left','right','top','bottom'];
const toVector = ({x,y,z}) => new THREE.Vector3(x,y,z);
const viewport = $('viewport'), overlay = $('overlay');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.OrthographicCamera(-15,15,15,-15,.01,2000);
const renderer = new THREE.WebGLRenderer({canvas:$('scene'),antialias:true,alpha:false});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000,1);
renderer.toneMapping = THREE.NoToneMapping;
const hemi = new THREE.HemisphereLight(0xffffff,0x50606d,2.1);
scene.add(hemi);
const keyLight = new THREE.DirectionalLight(0xffffff,2.5);
keyLight.position.set(-20,35,40); scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xbbd6ff,1);
fillLight.position.set(25,12,-30); scene.add(fillLight);

const state = {
  box:{width:10,depth:10,height:10},mode:'horizontal',angle:0,zoom:1,
  panX:0,panY:0,baseHeight:32,width:1,height:1,
  model:null,meshes:[],pin:null,source:null,file:null,objects:[],
  boxLines:null,grid:null,busy:false,setupOpen:true,
};
const raycaster = new THREE.Raycaster();
const manager = new THREE.LoadingManager();
manager.setURLModifier(url=>{
  if(!/^(data:|blob:)/i.test(url))throw new Error('Use a GLB with embedded textures and geometry.');
  return url;
});
const loader = new GLTFLoader(manager);
const screenVector = new THREE.Vector3();
let scheduled = false, toastTimer, gridKey='';
const vectors = () => {
  const b=viewBasis(state.mode,state.angle);
  const right=toVector(b.right), up=toVector(b.up);
  return {right,up,outward:new THREE.Vector3().crossVectors(right,up)};
};
const fmt = cm => cm === null || !Number.isFinite(cm) ? '—' : (Math.abs(cm*10)<.05?0:cm*10).toFixed(1);
const rounded = n => Number(n.toFixed(2));
function toast(message,ms=2600) {
  clearTimeout(toastTimer); $('viewport-status').textContent=message;
  if(ms) toastTimer=setTimeout(()=>$('viewport-status').textContent='',ms);
}
function error(message) { $('import-error').textContent=message; $('import-error').hidden=!message; }
function requestDraw() {
  if(scheduled) return;
  scheduled=true; requestAnimationFrame(()=>{scheduled=false;draw();});
}
function setSetup(open) {
  state.setupOpen=open; $('setup-content').hidden=!open;
  $('setup-toggle').setAttribute('aria-expanded',String(open));
  $('setup-chevron').textContent=open?'−':'+';
}
function setBusy(busy) {
  state.busy=busy;
  $$('#configuration input, #configuration select, #load-model, #import-header, #model-file').forEach(el=>el.disabled=busy);
}
function storedSession(value) {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('model-distance-assist',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('sessions');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result, transaction=db.transaction('sessions',value===undefined?'readonly':'readwrite');
      const store=transaction.objectStore('sessions');
      const action=value===undefined?store.get('current'):store.put(value,'current');
      transaction.oncomplete=()=>{db.close();resolve(action.result);};
      transaction.onabort=transaction.onerror=()=>{db.close();reject(transaction.error);};
    };
  });
}
function validateGLB(buffer) {
  const view=new DataView(buffer);
  if(buffer.byteLength<20||view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==buffer.byteLength||view.getUint32(16,true)!==0x4e4f534a) {
    throw new Error('Choose a valid GLB 2.0 file.');
  }
  const length=view.getUint32(12,true);
  if(length>buffer.byteLength-20)throw new Error('This GLB file is incomplete.');
  const json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length)));
  for(const item of [...(json.buffers||[]),...(json.images||[])]) {
    if(item.uri!==undefined&&(typeof item.uri!=='string'||!/^data:/i.test(item.uri))) {
      throw new Error('Use a GLB with embedded textures and geometry.');
    }
  }
}
function meshMatrices(mesh,visit) {
  if(mesh.isInstancedMesh) {
    for(let i=0;i<mesh.count;i++) {
      const matrix=new THREE.Matrix4();
      mesh.getMatrixAt(i,matrix);visit(matrix.premultiply(mesh.matrixWorld));
    }
  }else visit(mesh.matrixWorld);
}
function meshSet(root) {
  const meshes=new Set();
  root.traverse(node=>{if(node.isMesh)meshes.add(node);});
  return meshes;
}
function localBounds(node) {
  if(node.matrixWorld.determinant()===0)throw new Error('The box has a zero scale. Choose another object.');
  const inverse=node.matrixWorld.clone().invert(), bounds=new THREE.Box3(), point=new THREE.Vector3();
  for(const mesh of meshSet(node))meshMatrices(mesh,world=>{
    const matrix=inverse.clone().multiply(world);
    for(let i=0;i<mesh.geometry.attributes.position.count;i++)bounds.expandByPoint(mesh.getVertexPosition(i,point).applyMatrix4(matrix));
  });
  const size=bounds.getSize(new THREE.Vector3());
  if(!size.toArray().every(n=>Number.isFinite(n)&&n>0))throw new Error('Choose a box with width, depth, and height.');
  return bounds;
}
function inspectObjects(gltf) {
  const nodes=[];
  gltf.scene.traverse(node=>{
    const index=gltf.parser.associations.get(node)?.nodes;
    if(index!==undefined&&meshSet(node).size)nodes.push({id:String(index),name:node.name||'Object '+(index+1),node});
  });
  const semantic=new Set(nodes.map(item=>item.node));
  for(const object of nodes) {
    object.meshes=[];
    const visit=node=>{
      if(node!==object.node&&semantic.has(node))return;
      if(node.isMesh)object.meshes.push(node);
      node.children.forEach(visit);
    };
    visit(object.node);
  }
  return nodes;
}
function populateConfiguration() {
  $('configuration').hidden=false;
  const select=$('box-object');select.replaceChildren();
  for(const object of state.objects) {
    const option=document.createElement('option');
    option.value=object.id;option.textContent=object.name;select.append(option);
  }
  const suggested=state.objects.find(o=>/box|block|stock|cube/i.test(o.name))||state.objects.find(o=>o.meshes.length===1&&o.meshes[0].geometry.attributes.position.count<=24);
  if(suggested)select.value=suggested.id;
  changeBox();
}
function changeBox() {
  if(!state.source)return;
  error('');
  const box=state.objects.find(o=>o.id===$('box-object').value), list=$('model-objects');
  list.replaceChildren();
  if(!box)return;
  try {
    const size=localBounds(box.node).getSize(new THREE.Vector3());
    const elements=box.node.matrixWorld.elements;
    const dimensions=[size.x*Math.hypot(...elements.slice(0,3)),size.z*Math.hypot(...elements.slice(8,11)),size.y*Math.hypot(...elements.slice(4,7))];
    dimensionIds.forEach((id,i)=>$(id).value=Number((dimensions[i]*100).toPrecision(6)));
  }catch(e){error(e.message);}
  const excluded=meshSet(box.node);
  for(const object of state.objects.filter(o=>o.meshes.some(mesh=>!excluded.has(mesh)))) {
    const label=document.createElement('label'), checkbox=document.createElement('input');
    checkbox.type='checkbox';checkbox.value=object.id;
    let visible=true;
    for(let node=object.node;node;node=node.parent)visible=visible&&node.visible;
    checkbox.checked=visible;checkbox.addEventListener('change',updateMeshCount);
    label.append(checkbox,document.createTextNode(object.name));list.append(label);
  }
  updateMeshCount();
}
function updateMeshCount(){ $('mesh-count').textContent=$$('#model-objects input:checked').length+' selected'; }
function disposeModel(root,source=false) {
  const textures=new Set(),materials=new Set(),geometries=new Set();
  root?.traverse(object=>{
    if(!object.isMesh)return;
    geometries.add(object.geometry);
    for(const material of object.userData.viewerMaterials||(Array.isArray(object.material)?object.material:[object.material]))if(material)materials.add(material);
  });
  for(const material of materials) {
    if(source)for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
    material.dispose();
  }
  textures.forEach(texture=>texture.dispose());geometries.forEach(geometry=>geometry.dispose());
}
function clearModel() {
  if(state.model){scene.remove(state.model);disposeModel(state.model);}
  state.model=null;state.meshes=[];state.pin=null;
  if(state.boxLines)state.boxLines.visible=false;
  clearGrid();updateReadouts();
  $('empty-state').hidden=false;$('block-summary').hidden=true;$('warnings').hidden=true;
  $('source-name').textContent='No model loaded';requestDraw();
}
async function readModel(file) {
  $('progress').value=10;$('progress-message').textContent='Reading '+file.name+'…';
  const buffer=await file.arrayBuffer();validateGLB(buffer);
  $('progress').value=35;$('progress-message').textContent='Loading model and textures…';
  const gltf=await loader.parseAsync(buffer,'');
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(node=>node.skeleton?.update());
  const objects=inspectObjects(gltf);
  if(!objects.length){disposeModel(gltf.scene,true);throw new Error('This GLB contains no mesh objects.');}
  clearModel();disposeModel(state.source,true);
  state.source=gltf.scene;state.file=file;state.objects=objects;
  $('progress').value=100;populateConfiguration();
}
async function importFile(file) {
  if(state.busy||!file)return;
  setSetup(true);error('');
  if(!file.name.toLowerCase().endsWith('.glb')){error('Choose a .glb file.');return;}
  setBusy(true);$('import-progress').hidden=false;
  try{await readModel(file);}catch(e){error(e.message);}
  finally{setBusy(false);$('import-progress').hidden=true;$('model-file').value='';}
}
function selection() {
  const boxSizeCm=dimensionIds.map(id=>Number($(id).value));
  const modelObjects=[...$$('#model-objects input:checked')].map(el=>el.value);
  if(boxSizeCm.some(n=>!Number.isFinite(n)||n<=0))throw new Error('Enter a positive size for each side of the box.');
  if(!modelObjects.length)throw new Error('Select at least one model object.');
  return {boxObject:$('box-object').value,boxSizeCm,modelObjects};
}
async function loadSelection() {
  if(state.busy||!state.source)return;
  error('');
  try {
    const selected=selection();setBusy(true);$('import-progress').hidden=false;
    $('progress').value=70;$('progress-message').textContent='Preparing view…';
    await new Promise(requestAnimationFrame);
    displaySelection(selected);setSetup(false);
    try{await storedSession({file:state.file,...selected});}catch{toast('Loaded. This browser could not save the session.');}
  }catch(e){error(e.message);}finally{setBusy(false);$('import-progress').hidden=true;}
}
function displaySelection(selected) {
  const box=state.objects.find(o=>o.id===selected.boxObject);
  if(!box)throw new Error('Choose a box object.');
  const bounds=localBounds(box.node), size=bounds.getSize(new THREE.Vector3()), center=bounds.getCenter(new THREE.Vector3());
  const [width,depth,height]=selected.boxSizeCm;
  const transform=new THREE.Matrix4().makeScale(width/size.x,height/size.y,depth/size.z)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x,-center.y,-center.z)).multiply(box.node.matrixWorld.clone().invert());
  const excluded=meshSet(box.node), meshes=new Set();
  for(const object of state.objects)if(selected.modelObjects.includes(object.id))for(const mesh of object.meshes)if(!excluded.has(mesh))meshes.add(mesh);
  if(!meshes.size)throw new Error('Select at least one model object outside the box object.');
  const model=new THREE.Group();
  for(const source of meshes)meshMatrices(source,world=>{
    const geometry=source.geometry.clone();
    if(source.isSkinnedMesh||source.morphTargetInfluences?.some(value=>value!==0)) {
      const position=geometry.attributes.position, point=new THREE.Vector3();
      for(let i=0;i<position.count;i++){source.getVertexPosition(i,point);position.setXYZ(i,point.x,point.y,point.z);}
      geometry.morphAttributes={};geometry.computeVertexNormals();
    }
    const object=new THREE.Mesh(geometry);object.name=source.name;
    object.matrixAutoUpdate=false;object.matrix.copy(transform).multiply(world);
    const originals=Array.isArray(source.material)?source.material:[source.material];
    const textured=originals.map(original=>new THREE.MeshBasicMaterial({
      map:original.map,color:original.color,side:THREE.DoubleSide,
      transparent:original.transparent,opacity:original.opacity,
      alphaTest:original.alphaTest,vertexColors:original.vertexColors
    }));
    const shaded=originals.map(original=>new THREE.MeshStandardMaterial({
      color:0xc1c6c9,roughness:.8,metalness:0,side:THREE.DoubleSide,
      transparent:original.transparent,opacity:original.opacity,alphaTest:original.alphaTest
    }));
    object.userData.viewerTextured=textured;object.userData.viewerShaded=shaded;
    object.userData.viewerMaterials=[...textured,...shaded];
    object.material=Array.isArray(source.material)?textured:textured[0];model.add(object);
  });
  if(state.model){scene.remove(state.model);disposeModel(state.model);}
  state.model=model;state.meshes=model.children;state.pin=null;
  scene.add(model);model.updateMatrixWorld(true);
  state.box={width,depth,height};state.mode='horizontal';state.angle=0;
  $('show-texture').checked=true;$('empty-state').hidden=true;$('source-name').textContent=state.file.name;
  $('block-summary').hidden=false;$('block-summary').innerHTML='<strong>'+rounded(width)+' × '+rounded(depth)+' × '+rounded(height)+' cm</strong> · width × depth × height';
  const modelBounds=new THREE.Box3().setFromObject(model,true);
  const stockBounds=new THREE.Box3(new THREE.Vector3(-width/2,-height/2,-depth/2),new THREE.Vector3(width/2,height/2,depth/2));
  const outside=!stockBounds.expandByScalar(.002).containsBox(modelBounds);
  $('warnings').textContent=outside?'Model extends outside the box.':'';$('warnings').hidden=!outside;
  makeBox();fitView();updateControls();
}

function makeBox(){
  gridKey='';
  if(state.boxLines){scene.remove(state.boxLines);state.boxLines.geometry.dispose();state.boxLines.material.dispose();}
  const b=state.box,geometry=new THREE.BoxGeometry(b.width,b.height,b.depth);
  state.boxLines=new THREE.LineSegments(new THREE.EdgesGeometry(geometry),new THREE.LineBasicMaterial({color:0x54818c,transparent:true,opacity:.38,depthTest:false}));
  geometry.dispose();state.boxLines.renderOrder=3;
  state.boxLines.visible=$('show-walls').checked;scene.add(state.boxLines);
}
function fitView(){
  const aspect=state.width/state.height,b=state.box;
  state.baseHeight=state.mode==='horizontal'?Math.max(b.height,Math.hypot(b.width,b.depth)/aspect)*1.24:Math.max(b.depth,b.width/aspect)*1.24;
  state.panX=state.panY=0;state.zoom=1;requestDraw();
}
function updateCamera(){
  const {right,up,outward}=vectors(),half=state.baseHeight/2;
  const aspect=state.width/state.height;
  camera.left=-half*aspect;camera.right=half*aspect;camera.top=half;camera.bottom=-half;
  camera.zoom=state.zoom;
  const target=right.clone().multiplyScalar(state.panX).addScaledVector(up,state.panY);
  const distance=Math.max(state.box.width,state.box.height,state.box.depth)*6;
  camera.position.copy(target).addScaledVector(outward,distance);camera.up.copy(up);camera.far=distance*4+100;
  camera.lookAt(target);camera.updateProjectionMatrix();camera.updateMatrixWorld();
}
function clearGrid(){
  if(!state.grid)return;
  scene.remove(state.grid);state.grid.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});
  state.grid=null;
}
function updateGrid(){
  const pixelsPerCm=state.height*state.zoom/state.baseHeight;
  const fade=state.zoom<=1?0:THREE.MathUtils.clamp((pixelsPerCm*.1-4)/4,0,1);
  const key=[state.mode,state.angle,state.zoom.toFixed(4),state.width,state.height,state.baseHeight,JSON.stringify(state.box),$('show-grid').checked].join('|');
  if(key===gridKey)return;gridKey=key;clearGrid();
  if(!$('show-grid').checked||!state.model)return;
  const bounds=projectedBounds(state.box,state.mode,state.angle);
  const {right,up,outward}=vectors();
  const center=outward.multiplyScalar(-Math.hypot(state.box.width,state.box.height,state.box.depth));
  const group=new THREE.Group();
  const point=(x,y)=>center.clone().addScaledVector(right,x).addScaledVector(up,y);
  const addLines=(spacing,color,opacity,axes=false)=>{
    const vertices=[];
    const add=(a,b)=>vertices.push(...a.toArray(),...b.toArray());
    for(const x of centeredGridPositions(bounds.width/2,spacing)){
      if(axes ? x!==0 : x===0)continue;
      if(spacing<1&&Math.abs(x-Math.round(x))<1e-7)continue;
      add(point(x,bounds.minY),point(x,bounds.maxY));
    }
    for(const y of centeredGridPositions(bounds.height/2,spacing)){
      if(axes ? y!==0 : y===0)continue;
      if(spacing<1&&Math.abs(y-Math.round(y))<1e-7)continue;
      add(point(bounds.minX,y),point(bounds.maxX,y));
    }
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
    const lines=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color,transparent:true,opacity,depthWrite:false}));
    lines.renderOrder=-1;group.add(lines);
  };
  if(fade>0)addLines(.1,0x233136,fade*.75);
  addLines(1,0x34464d,.8);addLines(1,0x6b9293,.9,true);
  scene.add(group);state.grid=group;
}
function screenPoint(world){
  const v=screenVector.copy(world).project(camera);
  return {x:(v.x+1)*state.width/2,y:(1-v.y)*state.height/2};
}
function pinWorld(){return state.pin?state.pin.object.localToWorld(state.pin.local.clone()):null;}
function measurements(){
  const p=pinWorld();
  return p?{point:p,edge:measurePoint(p,state.box,state.mode,state.angle),wall:measureWallPoint(p,state.box,state.mode,state.angle)}:null;
}
function updateReadouts(){
  const m=measurements();
  for(const row of $$('#readout-body tr')){
    row.children[1].textContent=m?fmt(m.edge[row.dataset.side]):'—';
    row.children[2].textContent=m?fmt(m.wall[row.dataset.side]):'—';
  }
  $('clear-point').disabled=!m;
  return m;
}
function svgLine(a,b,cls){return '<line class="'+cls+'" x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'"/>';}
function labelFor(side,edge,wall,p,end) {
  const w=116,h=51,pad=9;
  let x,y;
  if(side==='left'){x=(p.x+end.x)/2-w/2;y=p.y-h-11;}
  if(side==='right'){x=(p.x+end.x)/2-w/2;y=p.y+11;}
  if(side==='top'){x=p.x+13;y=(p.y+end.y)/2-h/2;}
  if(side==='bottom'){x=p.x-w-13;y=(p.y+end.y)/2-h/2;}
  x=THREE.MathUtils.clamp(x,pad,Math.max(pad,state.width-w-pad));
  y=THREE.MathUtils.clamp(y,41,Math.max(41,state.height-h-pad));
  return '<g class="measure-label" data-direction="'+side+'" transform="translate('+x+','+y+')"><rect class="label-bg" width="'+w+'" height="'+h+'" rx="4"/><text class="direction-text" x="8" y="12">'+side.toUpperCase()+'</text><text class="edge-text" x="8" y="28">Edge '+fmt(edge)+' mm</text><text class="wall-text" x="8" y="43">Wall '+fmt(wall)+' mm</text></g>';
}
function updateOverlay(){
  if(!state.model){overlay.replaceChildren();return;}
  const bounds=projectedBounds(state.box,state.mode,state.angle);
  const {right,up}=vectors();
  const plane=(x,y)=>screenPoint(right.clone().multiplyScalar(x).addScaledVector(up,y));
  const tl=plane(bounds.minX,bounds.maxY),br=plane(bounds.maxX,bounds.minY);
  let svg='<rect class="box-outline" x="'+tl.x+'" y="'+tl.y+'" width="'+(br.x-tl.x)+'" height="'+(br.y-tl.y)+'"/>';
  const m=updateReadouts();
  if(m){
    const p=screenPoint(m.point);
    const ends={left:{x:tl.x,y:p.y},right:{x:br.x,y:p.y},top:{x:p.x,y:tl.y},bottom:{x:p.x,y:br.y}};
    let labels='';
    for(const side of sides){
      const end=ends[side],hit=m.wall.endpoints[side];
      svg+=svgLine(p,end,'cross-line');
      svg+='<rect class="edge-mark" x="'+(end.x-3.5)+'" y="'+(end.y-3.5)+'" width="7" height="7"/>';
      if(hit){
        const wp=screenPoint(toVector(hit));
        svg+=svgLine(p,wp,'wall-line');
        const r=6;
        svg+='<path class="wall-mark" d="M '+wp.x+' '+(wp.y-r)+' L '+(wp.x+r)+' '+wp.y+' L '+wp.x+' '+(wp.y+r)+' L '+(wp.x-r)+' '+wp.y+' Z"/>';
      }
      labels+=labelFor(side,m.edge[side],m.wall[side],p,end);
    }
    svg+='<circle class="pin" cx="'+p.x+'" cy="'+p.y+'" r="5"/><circle cx="'+p.x+'" cy="'+p.y+'" r="1.5" fill="white"/>';
    svg+=labels;
  }
  overlay.innerHTML=svg;
}
function updateControls(){
  $$('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===state.mode));
  $$('[data-angle]').forEach(el=>el.classList.toggle('active',Math.abs(Number(el.dataset.angle)-state.angle)<.001));
  $('angle').value=rounded(state.angle);
  $('rotation-controls').classList.toggle('disabled',state.mode!=='horizontal');
  $('rotation-controls').querySelectorAll('button,input').forEach(el=>el.disabled=state.mode!=='horizontal');
  const cardinal={0:'FRONT',90:'RIGHT',180:'BACK',270:'LEFT'};
  $('view-badge').textContent=state.mode==='horizontal'?(cardinal[state.angle]||'HORIZONTAL')+' · '+rounded(state.angle)+'°':state.mode.toUpperCase()+' VIEW';
}
function setAngle(value){
  if(!Number.isFinite(value))return;
  state.angle=normalizeDegrees(value);updateControls();requestDraw();
}
function setView(mode){
  if(state.mode===mode)return;
  state.mode=mode;
  fitView();updateControls();requestDraw();
}
function draw(){
  updateCamera();updateGrid();renderer.render(scene,camera);updateOverlay();
  const b=projectedBounds(state.box,state.mode,state.angle);
  $('view-size').textContent=state.model?'Outline '+rounded(b.width)+' × '+rounded(b.height)+' cm':'Orthographic view';
  $('zoom-label').textContent=Math.round(state.zoom*100)+'%';
}
function resize(){
  const rect=viewport.getBoundingClientRect();
  const oldAspect=state.width/state.height,newAspect=rect.width/rect.height;
  state.width=Math.max(1,rect.width);state.height=Math.max(1,rect.height);
  renderer.setSize(state.width,state.height,false);
  overlay.setAttribute('viewBox','0 0 '+state.width+' '+state.height);
  if(Math.abs(newAspect-oldAspect)>.05&&state.zoom===1)fitView();
  requestDraw();
}
new ResizeObserver(resize).observe(viewport);
function pick(event){
  if(!state.model)return;
  updateCamera();
  const rect=viewport.getBoundingClientRect();
  const mouse=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);
  raycaster.setFromCamera(mouse,camera);
  const hit=raycaster.intersectObjects(state.meshes,false)[0];
  if(!hit){toast('Select a model surface.');return;}
  state.pin={object:hit.object,local:hit.object.worldToLocal(hit.point.clone())};
  $('viewport-status').textContent='';requestDraw();
}
let drag=null;
viewport.addEventListener('pointerdown',event=>{
  if(event.button!==0&&event.button!==2)return;
  drag={id:event.pointerId,startX:event.clientX,startY:event.clientY,
    angle:state.angle,panX:state.panX,panY:state.panY,moved:false,
    pan:event.shiftKey||event.button===2||state.mode!=='horizontal'};
  viewport.setPointerCapture(event.pointerId);
});
viewport.addEventListener('pointermove',event=>{
  if(!drag||drag.id!==event.pointerId)return;
  const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;
  if(Math.hypot(dx,dy)>4)drag.moved=true;
  if(!drag.moved)return;
  if(drag.pan){
    const scale=state.baseHeight/state.zoom/state.height;
    state.panX=drag.panX-dx*scale;state.panY=drag.panY+dy*scale;requestDraw();
  }else setAngle(drag.angle-dx*.35);
});
viewport.addEventListener('pointerup',event=>{
  if(!drag||drag.id!==event.pointerId)return;
  if(!drag.moved&&event.button===0)pick(event);
  drag=null;
  if(viewport.hasPointerCapture(event.pointerId))viewport.releasePointerCapture(event.pointerId);
});
viewport.addEventListener('pointercancel',()=>drag=null);
viewport.addEventListener('contextmenu',event=>event.preventDefault());
viewport.addEventListener('wheel',event=>{
  event.preventDefault();if(!state.model)return;
  const rect=viewport.getBoundingClientRect();
  const mx=(event.clientX-rect.left)/rect.width-.5,my=.5-(event.clientY-rect.top)/rect.height;
  const oldHeight=state.baseHeight/state.zoom;
  const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?state.height:1);
  state.zoom=THREE.MathUtils.clamp(state.zoom*Math.exp(-delta*.0015),.3,50);
  const nextHeight=state.baseHeight/state.zoom;
  state.panX+=mx*(oldHeight-nextHeight)*state.width/state.height;
  state.panY+=my*(oldHeight-nextHeight);requestDraw();
},{passive:false});
$('angle').addEventListener('change',()=>setAngle(Number($('angle').value)));
$('angle').addEventListener('keydown',event=>{if(event.key==='Enter'){$('angle').blur();setAngle(Number($('angle').value));}});
$$('[data-view]').forEach(el=>el.addEventListener('click',()=>setView(el.dataset.view)));
$$('[data-angle]').forEach(el=>el.addEventListener('click',()=>setAngle(Number(el.dataset.angle))));
$$('[data-step]').forEach(el=>el.addEventListener('click',()=>setAngle(state.angle+Number(el.dataset.step))));
$('fit-view').addEventListener('click',fitView);
$('clear-point').addEventListener('click',()=>{state.pin=null;requestDraw();});
$('show-grid').addEventListener('change',requestDraw);
$('show-walls').addEventListener('change',()=>{if(state.boxLines)state.boxLines.visible=$('show-walls').checked;requestDraw();});
$('show-texture').addEventListener('change',()=>{
  for(const mesh of state.meshes){
    const mats=$('show-texture').checked?mesh.userData.viewerTextured:mesh.userData.viewerShaded;
    mesh.material=Array.isArray(mesh.material)?mats:mats[0];
  }requestDraw();
});
$('setup-toggle').addEventListener('click',()=>setSetup(!state.setupOpen));
$('import-header').addEventListener('click',()=>$('model-file').click());
$('model-file').addEventListener('change',event=>importFile(event.target.files[0]));
$('box-object').addEventListener('change',changeBox);
$('load-model').addEventListener('click',loadSelection);
const drop=$('drop-zone');
for(const type of ['dragenter','dragover'])drop.addEventListener(type,event=>{event.preventDefault();drop.classList.add('dragging');});
for(const type of ['dragleave','drop'])drop.addEventListener(type,event=>{event.preventDefault();drop.classList.remove('dragging');});
drop.addEventListener('drop',event=>importFile(event.dataTransfer.files[0]));
document.addEventListener('dragover',event=>event.preventDefault());
document.addEventListener('drop',event=>{event.preventDefault();if(event.target!==drop&&!drop.contains(event.target))importFile(event.dataTransfer.files[0]);});
window.addEventListener('error',()=>toast('Unable to render. Reload the page.',6000));
async function restore(){
  setBusy(true);
  try {
    const previous=await storedSession();
    if(previous?.file) {
      $('import-progress').hidden=false;
      await readModel(previous.file);
      $('box-object').value=previous.boxObject;changeBox();
      dimensionIds.forEach((id,i)=>$(id).value=previous.boxSizeCm[i]);
      $$('#model-objects input').forEach(el=>el.checked=previous.modelObjects.includes(el.value));updateMeshCount();
      displaySelection(previous);setSetup(false);
    }
  }catch{toast('Import a .glb file.');}finally{setBusy(false);$('import-progress').hidden=true;}
}
resize();updateControls();restore();
