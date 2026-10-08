import {mkdirSync,copyFileSync,cpSync} from 'node:fs';
mkdirSync('dist',{recursive:true});
for(const file of ['index.html','style.css','app.js','protocol.js','sw.js','icon.svg','manifest.webmanifest'])copyFileSync(file,`dist/${file}`);
cpSync('edge-functions','dist/edge-functions',{recursive:true});
copyFileSync('package.json','dist/package.json');
