import{u as b,_ as h}from"./app.00aa4bb9.js";import{g as f,r as g,u as y,h as v,o as x,b as k,d as e,i as j,t as c,j as r}from"./vendor.7d53e73b.js";var i={};const C={class:"text-4xl"},N=e("h1",null,"Upload to S3",-1),S=e("div",{class:"py-4"},null,-1),w={class:"hidden",for:"input"},B=["disabled"],T=f({setup(U){const p=b(),n=g(p.savedName),u=y(),d=()=>{n.value&&u.push(`/hi/${encodeURIComponent(n.value)}`)},{t:a}=v(),m=t=>{console.log(t);const o={contentType:t[0].type,fileName:t[0].name};fetch("https://gjq4kpd0uk.execute-api.us-east-1.amazonaws.com/stage/echo",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)}).then(s=>{console.log(s)})};return(t,o)=>{const s=h;return x(),k("div",null,[e("p",C,[j(s,{class:"inline-block"})]),N,S,e("input",{id:"input",type:"file",autocomplete:"false",p:"x-4 y-2",w:"250px",text:"center",bg:"transparent",border:"~ rounded gray-200 dark:gray-700",outline:"none active:none",onChange:o[0]||(o[0]=_=>{var l;return m((l=_.target)==null?void 0:l.files)})},null,32),e("label",w,c(r(a)("intro.whats-your-name")),1),e("div",null,[e("button",{class:"m-3 text-sm btn",disabled:!n.value,onClick:d},c(r(a)("button.go")),9,B)])])}}});typeof i=="function"&&i(T);export{T as default};