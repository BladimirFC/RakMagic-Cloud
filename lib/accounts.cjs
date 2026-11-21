'use strict';
const fs=require('node:fs'),path=require('node:path');
const validNickname=value=>typeof value==='string'&&value.length>=3&&value.length<=24&&!/[^A-Za-z0-9_\[\]().$=@]/.test(value);
function readChoice(directory,source){
  try{
    const file=path.join(directory,'state/account-choice.json');if(fs.statSync(file).size>4096)return null;
    const choice=JSON.parse(fs.readFileSync(file,'utf8'));
    if(choice.v!==1||choice.source?.host!==source.host||choice.source?.port!==source.port||choice.source?.nickname!==source.nickname||!validNickname(choice.nickname)||!Array.isArray(choice.names)||choice.names.length>30||!choice.names.every(validNickname))return null;
    return choice;
  }catch(_){return null;}
}
function saveChoice(directory,source,nickname,names){
  if(!validNickname(nickname))throw Error('Invalid nickname');
  const file=path.join(directory,'state/account-choice.json'),temp=file+'.tmp';
  const recent=[...new Set([...names.filter(n=>n!==nickname),nickname])].slice(-30);
  fs.writeFileSync(temp,JSON.stringify({v:1,source,nickname,names:recent})+'\n',{mode:0o600});fs.chmodSync(temp,0o600);fs.renameSync(temp,file);
  return recent;
}
module.exports={validNickname,readChoice,saveChoice};
