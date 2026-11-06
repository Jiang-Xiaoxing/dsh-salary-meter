// Small landmark mesh: interpolate the hands, face and bowl, rather than
// speeding up a slideshow. The atlas and render surface are capped at 2× CSS size.
const FPS = 30;
const CELL = 224;
const ATLAS = CELL * 3;
const TAU = Math.PI * 2;
const ease = progress => progress * progress * (3 - 2 * progress);
const mix = (start, end, progress) => start + (end - start) * progress;

const BORDER = [[0,0],[.25,0],[.5,0],[.75,0],[1,0],[1,.25],[1,.5],[1,.75],[1,1],[.75,1],[.5,1],[.25,1],[0,1],[0,.75],[0,.5],[0,.25]];
const HEAD = [[.49,.08],[.29,.17],[.69,.17],[.24,.34],[.73,.34],[.28,.5],[.68,.5],[.48,.56]];
const EYES = [[.31,.4],[.365,.405],[.42,.405],[.50,.405],[.555,.405],[.61,.4]];
const MOUTH = [[.425,.50],[.48,.482],[.535,.50],[.48,.525]];
const HAND = [[-.045,0],[0,-.04],[.045,0],[0,.04]];
const BOWL = [[-.155,-.055],[0,-.135],[.155,-.055],[.13,.035],[0,.10],[-.13,.035]];
const BODY = [[.23,.64],[.76,.64],[.24,.83],[.72,.83],[.35,.94],[.58,.94],[.80,.83],[.90,.67]];
const POSES = [
  { head:[0,0,0], eyes:1, mouth:.18, hand:[.31,.62], right:[.62,.745], bowl:[.475,.735] },
  { head:[0,.035,.12], eyes:.85, mouth:.18, hand:[.31,.61], right:[.62,.745], bowl:[.475,.735] },
  { head:[0,0,0], eyes:1, mouth:1, hand:[.36,.59], right:[.62,.745], bowl:[.475,.735] },
  { head:[0,.02,0], eyes:.08, mouth:.20, hand:[.31,.66], right:[.62,.775], bowl:[.475,.765] },
  { head:[.005,.055,-.13], eyes:.65, mouth:.16, hand:[.31,.66], right:[.62,.775], bowl:[.475,.765] },
  { head:[.01,.045,0], eyes:1.1, mouth:.48, hand:[.34,.72], right:[.64,.72], bowl:[.49,.73] },
  { head:[-.015,.065,.01], eyes:.45, mouth:.18, hand:[.29,.81], right:[.59,.59], bowl:[.445,.80] },
  { head:[.005,.02,-.035], eyes:.08, mouth:.85, hand:[.34,.77], right:[.64,.77], bowl:[.49,.78], tail:-.10 },
  { head:[-.015,.075,-.30], eyes:.08, mouth:.18, hand:[.34,.78], right:[.64,.78], bowl:[.49,.78], tail:.13 },
];

function headPoint([x,y], pose) {
  const [offsetX, offsetY, angle] = pose.head;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    .48 + offsetX + (x - .48) * cosine - (y - .38) * sine,
    .38 + offsetY + (x - .48) * sine + (y - .38) * cosine,
  ];
}

function points(pose) {
  return [
    ...BORDER,
    ...HEAD.map(p => headPoint(p, pose)),
    ...EYES.map(([x,y]) => headPoint([x, .405+(y-.405)*pose.eyes], pose)),
    ...MOUTH.map(([x,y]) => headPoint([x, .50+(y-.50)*pose.mouth*2.1], pose)),
    ...HAND.map(([x,y]) => [x+pose.hand[0],y+pose.hand[1]]),
    ...HAND.map(([x,y]) => [x+pose.right[0],y+pose.right[1]]),
    ...BOWL.map(([x,y]) => [x+pose.bowl[0],y+pose.bowl[1]]),
    ...BODY.map(([x,y], i) => [x,y+(i===7?(pose.tail||0):0)]),
  ];
}

// Delaunay topology is calculated once for the shared anatomical landmarks.
function triangulate(input) {
  const vertices = [...input, [-10,-10],[10,-10],[0,10]];
  const n = input.length;
  let triangles = [[n,n+1,n+2]];
  function contains([a,b,c], p) {
    const [ax,ay] = vertices[a], [bx,by] = vertices[b], [cx,cy] = vertices[c];
    const d = 2*(ax*(by-cy)+bx*(cy-ay)+cx*(ay-by));
    if (Math.abs(d)<1e-10) return false;
    const aa=ax*ax+ay*ay, bb=bx*bx+by*by, cc=cx*cx+cy*cy;
    const x=(aa*(by-cy)+bb*(cy-ay)+cc*(ay-by))/d;
    const y=(aa*(cx-bx)+bb*(ax-cx)+cc*(bx-ax))/d;
    return (p[0]-x)**2+(p[1]-y)**2 < (ax-x)**2+(ay-y)**2-1e-12;
  }
  for (let i=0;i<n;i++) {
    const bad = triangles.filter(t => contains(t,vertices[i]));
    const edges = new Map();
    for (const [a,b,c] of bad) for (const [u,v] of [[a,b],[b,c],[c,a]]) {
      const key = u<v?`${u},${v}`:`${v},${u}`;
      if (edges.has(key)) edges.delete(key); else edges.set(key,[u,v]);
    }
    triangles = triangles.filter(t => !bad.includes(t));
    for (const edge of edges.values()) triangles.push([...edge,i]);
  }
  return triangles.filter(t => t.every(i => i<n)).flat();
}

const MESHES = POSES.map(points);
const INDICES = triangulate(MESHES[0]);
const ROUTINE = [
  [0,'idle',.4,1.2], [1,'scoop',.9,.15], [2,'bite',.8,.25], [3,'chew',.4,1.5], [0,'idle',.55,.8],
  [1,'scoop',.9,.1], [2,'bite',.8,.25], [3,'chew',.4,1.5], [4,'peek',.65,1.4], [0,'idle',.65,1.2],
  [1,'scoop',.9,.15], [2,'bite',.8,.25], [3,'chew',.4,1.5], [6,'wipe',.7,.8], [0,'idle',.65,.8],
  [7,'full',.8,1.3], [0,'idle',.7,1.8], [8,'sleep',1.2,3], [0,'idle',.9,1.2],
];

function renderer(canvas, bitmap) {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('无法创建动画画布');
  const shaders=[];
  const compile = (type, source) => {
    const shader=gl.createShader(type);
    gl.shaderSource(shader,source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    shaders.push(shader);
    return shader;
  };
  const program=gl.createProgram();
  gl.attachShader(program,compile(gl.VERTEX_SHADER,`
    attribute vec2 position; attribute vec2 sourceA; attribute vec2 sourceB;
    varying vec2 uvA; varying vec2 uvB;
    void main(){gl_Position=vec4(position.x*2.0-1.0,1.0-position.y*2.0,0,1);uvA=sourceA;uvB=sourceB;}
  `));
  gl.attachShader(program,compile(gl.FRAGMENT_SHADER,`
    precision mediump float; uniform sampler2D atlas; uniform float blend;
    varying vec2 uvA; varying vec2 uvB;
    void main(){gl_FragColor=mix(texture2D(atlas,uvA),texture2D(atlas,uvB),blend);}
  `));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const texture=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,bitmap);
  const buffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  const data=new Float32Array(INDICES.length*6);
  gl.bufferData(gl.ARRAY_BUFFER,data.byteLength,gl.DYNAMIC_DRAW);
  for (const [name,offset] of [['position',0],['sourceA',8],['sourceB',16]]) {
    const attribute=gl.getAttribLocation(program,name);
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,24,offset);
  }
  const blendUniform=gl.getUniformLocation(program,'blend');
  gl.uniform1i(gl.getUniformLocation(program,'atlas'),0);
  gl.clearColor(0,0,0,0);
  let size=0;
  return {
    draw(from,to,blend,time,action) {
      const desired=Math.round(112*Math.min(devicePixelRatio||1,2));
      if (size !== desired) {
        size = desired;
        canvas.width = canvas.height = size;
        gl.viewport(0, 0, size, size);
      }
      const a=MESHES[from], b=MESHES[to];
      const columnA=from%3, rowA=Math.floor(from/3), columnB=to%3, rowB=Math.floor(to/3);
      const breath=Math.sin(time*TAU/3.6)*.002;
      const sway=Math.sin(time*TAU/5.4)*.009;
      let offset=0;
      for(const index of INDICES){
        let x=mix(a[index][0],b[index][0],blend), y=mix(a[index][1],b[index][1],blend);
        if(index>=BORDER.length){
          const headWeight=Math.max(0,1-Math.abs(y-.35)/.35);
          x+=(.75-y)*sway*headWeight;
          y+=breath*Math.max(0,1-(y-.35));
          if(index===MESHES[0].length-1) y+=Math.sin(time*TAU/2.8)*.014;
          if(action==='chew'&&index>=16&&index<34){
            x+=(x<.48?-1:1)*Math.sin(time*TAU*2.6)*.0025;
            y+=Math.sin(time*TAU*2.6)*.0015;
          }
          if(action==='sleep')y+=Math.sin(time*TAU/3.8)*headWeight*.006;
        }
        data[offset++] = x;
        data[offset++] = y;
        data[offset++] = (columnA + a[index][0]) / 3;
        data[offset++] = (rowA + a[index][1]) / 3;
        data[offset++] = (columnB + b[index][0]) / 3;
        data[offset++] = (rowB + b[index][1]) / 3;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER,0,data);
      // Keep the outline opaque through most of a move. A short blend at the
      // midpoint avoids prolonged double eyes or chopsticks on the painted poses.
      gl.uniform1f(blendUniform, ease(Math.max(0, Math.min(1, (blend - .4) / .2))));
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES,0,INDICES.length);
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
      shaders.forEach(shader => gl.deleteShader(shader));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

export async function createWhaleAnimation(canvas, { signal, onAction = () => {}, onError = () => {} } = {}) {
  const response = await fetch('assets/actions.png', { signal });
  if (!response.ok) throw new Error('动作图片加载失败');
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: ATLAS,
    resizeHeight: ATLAS,
    resizeQuality: 'high',
    premultiplyAlpha: 'premultiply',
  });
  if (signal?.aborted) {
    bitmap.close();
    return null;
  }
  let surface;
  try {
    surface = renderer(canvas, bitmap);
  } catch (error) {
    canvas.getContext('webgl')?.getExtension('WEBGL_lose_context')?.loseContext();
    throw error;
  } finally {
    bitmap.close();
  }
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false;
  let busy = false;
  let frameRequest = null;
  let lastFrame = null;
  let previousTick = null;
  let elapsed = 0;
  let step = 0;
  let from = 0;
  let to = 0;
  let transition = .4;
  let hold = 1.2;
  let action = 'idle';
  let caught = false;
  const stats = {
    frames: 0, drawMs: 0, maxDrawMs: 0, animationSeconds: 0,
    textureBytes: ATLAS * ATLAS * 4, fpsLimit: FPS,
  };
  function announce() {
    canvas.dataset.action = action;
    onAction(action);
  }
  function draw() {
    const started = performance.now();
    surface.draw(from, to, ease(Math.min(1, elapsed / transition)), stats.animationSeconds, action);
    const duration = performance.now() - started;
    stats.frames++;
    stats.drawMs += duration;
    stats.maxDrawMs = Math.max(stats.maxDrawMs, duration);
  }
  function next() {
    from = to;
    if (caught) {
      caught = false;
      [to, action, transition, hold] = [0, 'idle', .55, .8];
    } else {
      step = (step + 1) % ROUTINE.length;
      if (busy && ROUTINE[step][1] === 'sleep') step = (step + 1) % ROUTINE.length;
      [to, action, transition, hold] = ROUTINE[step];
    }
    elapsed = 0;
    announce();
  }
  function tick(timestamp) {
    frameRequest = null;
    if (disposed || document.hidden || motion.matches) return;
    if (previousTick !== null) {
      const delta = Math.min((timestamp - previousTick) / 1000, .1);
      elapsed += delta;
      stats.animationSeconds += delta;
    }
    previousTick = timestamp;
    const slot = Math.floor(timestamp * FPS / 1000);
    if (lastFrame === null || slot > lastFrame) {
      lastFrame = slot;
      if (elapsed >= transition + hold) next();
      draw();
    }
    frameRequest = requestAnimationFrame(tick);
  }
  function visibility() {
    if (frameRequest !== null) cancelAnimationFrame(frameRequest);
    frameRequest = null;
    previousTick = null;
    lastFrame = null;
    if (disposed) return;
    canvas.dataset.animation = motion.matches ? 'reduced' : document.hidden ? 'paused' : 'running';
    if (motion.matches) {
      surface.draw(0, 0, 0, 0, 'idle');
      return;
    }
    if (!document.hidden) frameRequest = requestAnimationFrame(tick);
  }
  function lost(event) {
    event.preventDefault();
    if (!disposed) {
      dispose();
      onError(new Error('动画画布暂时不可用'));
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (frameRequest !== null) cancelAnimationFrame(frameRequest);
    frameRequest = null;
    document.removeEventListener('visibilitychange',visibility);
    motion.removeEventListener('change',visibility);
    canvas.removeEventListener('webglcontextlost',lost);
    signal?.removeEventListener('abort',dispose);
    surface.dispose();
    canvas.width=canvas.height=1;
    canvas.dataset.animation='disposed';
    canvas.salaryAnimation=null;
  }
  const controller={
    catch() {
      if (disposed) return;
      from = to;
      to = 5;
      action = 'caught';
      transition = .28;
      hold = 2;
      elapsed = 0;
      caught = true;
      announce();
      if (motion.matches) surface.draw(5, 5, 0, 0, 'caught');
    },
    setBusy(value) {
      if (disposed) return;
      const wake = value && !busy && action === 'sleep';
      busy = value;
      if (wake) {
        from = to;
        to = 0;
        action = 'idle';
        transition = .5;
        hold = .6;
        elapsed = 0;
        announce();
      }
    },
    getStats() {
      return {
        ...stats, action, from, to,
        progress: Math.min(1, elapsed / transition),
        state: canvas.dataset.animation,
        averageDrawMs: stats.drawMs / Math.max(1, stats.frames),
      };
    },
    dispose,
  };
  canvas.salaryAnimation=controller;
  canvas.dataset.renderer='webgl';
  canvas.dataset.ready='true';
  document.addEventListener('visibilitychange',visibility);
  motion.addEventListener('change',visibility);
  canvas.addEventListener('webglcontextlost',lost);
  signal?.addEventListener('abort',dispose,{once:true});
  announce();
  draw();
  visibility();
  return controller;
}
