"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./v13-integrations-manager.module.css";

type CatalogItem = { provider:string; label:string; category:string; authorization:string; capabilities:string[] };
type Connection = { id:string; provider:string; name:string; status:string; capabilities:string[]; scopes:string[]; configuration:Record<string,unknown>; syncPolicy:Record<string,unknown>; lastErrorCode:string; lastErrorMessage:string; lastSuccessAt:string|null; updatedAt:string };
type Mapping = { id:string; resourceType:string; direction:string; clarityType:string; conflictPolicy:string; mapping:Record<string,unknown>; enabled:boolean };
type Health = { connection:Connection; credentials:Array<{kind:string;configured:boolean;keyId:string;expiresAt:string|null;lastRotatedAt:string}>; events:Array<{severity:string;code:string;message:string;correlationId:string;createdAt:string}>; runs:Array<{id:string;resourceType:string;direction:string;triggerKind:string;status:string;received:number;created:number;updated:number;skipped:number;failed:number;retryCount:number;errorCode:string;errorMessage:string;createdAt:string}> };

const DEFAULT_CONFIG: Record<string,string> = {
  google: '{"clientId":"replace-me.apps.googleusercontent.com"}',
  microsoft: '{"clientId":"00000000-0000-0000-0000-000000000000","directory":"organizations"}',
  n8n: '{"webhookUrl":"https://n8n.example.com/webhook/clarity"}',
  ldap: '{"url":"ldaps://ldap.example.com:636","baseDn":"DC=example,DC=com","bindDn":"CN=svc-clarity,OU=Service,DC=example,DC=com"}'
};

export function V13IntegrationManager(){
  const [catalog,setCatalog]=useState<CatalogItem[]>([]); const [items,setItems]=useState<Connection[]>([]); const [selectedId,setSelectedId]=useState("");
  const [health,setHealth]=useState<Health|null>(null); const [mappings,setMappings]=useState<Mapping[]>([]); const [error,setError]=useState(""); const [message,setMessage]=useState(""); const [busy,setBusy]=useState(false);
  const [provider,setProvider]=useState("google"); const [name,setName]=useState("Connexion Google"); const [capabilities,setCapabilities]=useState("mail.read,calendar.read,contacts.read,files.read"); const [configuration,setConfiguration]=useState(DEFAULT_CONFIG.google); const [interval,setInterval]=useState("15");
  const [secretKind,setSecretKind]=useState("client_secret"); const [secretValue,setSecretValue]=useState("");
  const [resourceType,setResourceType]=useState("contacts"); const [clarityType,setClarityType]=useState("contact"); const [direction,setDirection]=useState("pull_only"); const [conflictPolicy,setConflictPolicy]=useState("external_wins"); const [mappingJson,setMappingJson]=useState("{}");

  const selected=useMemo(()=>items.find((item)=>item.id===selectedId)??null,[items,selectedId]);
  const request=useCallback(async(url:string,init?:RequestInit)=>{ const response=await fetch(url,init); const payload=(await response.json().catch(()=>({}))) as Record<string,unknown>; if(!response.ok) throw new Error(typeof payload.error==="string"?payload.error:`HTTP ${response.status}`); return payload; },[]);
  const run=useCallback(async<T,>(fn:()=>Promise<T>)=>{ setBusy(true); setError(""); setMessage(""); try{return await fn();}catch(cause){setError(cause instanceof Error?cause.message:"Erreur inconnue."); return undefined;}finally{setBusy(false);}},[]);
  const load=useCallback(async()=>{ const payload=await request("/api/integrations"); const next=Array.isArray(payload.items)?payload.items as Connection[]:[]; setItems(next); setCatalog(Array.isArray(payload.catalog)?payload.catalog as CatalogItem[]:[]); setSelectedId((current)=>current&&next.some((item)=>item.id===current)?current:(next[0]?.id??"")); },[request]);
  const loadDetails=useCallback(async(id:string)=>{ if(!id){setHealth(null);setMappings([]);return;} const [h,m]=await Promise.all([request(`/api/integrations/${encodeURIComponent(id)}/health`),request(`/api/integrations/${encodeURIComponent(id)}/mappings`)]); setHealth(h as unknown as Health); setMappings(Array.isArray(m.items)?m.items as Mapping[]:[]); },[request]);
  useEffect(()=>{
    let cancelled=false;
    request("/api/integrations")
      .then((payload)=>{
        if(cancelled)return;
        const next=Array.isArray(payload.items)?payload.items as Connection[]:[];
        setItems(next);
        setCatalog(Array.isArray(payload.catalog)?payload.catalog as CatalogItem[]:[]);
        setSelectedId((current)=>current&&next.some((item)=>item.id===current)?current:(next[0]?.id??""));
      })
      .catch((cause)=>{if(!cancelled)setError(cause instanceof Error?cause.message:"Integration Manager indisponible.");});
    return()=>{cancelled=true;};
  },[request]);
  useEffect(()=>{
    if(!selectedId)return;
    let cancelled=false;
    Promise.all([
      request(`/api/integrations/${encodeURIComponent(selectedId)}/health`),
      request(`/api/integrations/${encodeURIComponent(selectedId)}/mappings`),
    ])
      .then(([h,m])=>{
        if(cancelled)return;
        setHealth(h as unknown as Health);
        setMappings(Array.isArray(m.items)?m.items as Mapping[]:[]);
      })
      .catch((cause)=>{if(!cancelled)setError(cause instanceof Error?cause.message:"Health Center indisponible.");});
    return()=>{cancelled=true;};
  },[selectedId,request]);

  const mutate=async(url:string,method:string,body?:unknown)=>request(url,{method,headers:body===undefined?undefined:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  const reloadSelected=async()=>{await load(); if(selectedId) await loadDetails(selectedId);};
  const create=async(event:FormEvent)=>{event.preventDefault(); const config=parseObject(configuration,"Configuration JSON invalide."); const caps=splitCsv(capabilities); const result=await run(()=>mutate("/api/integrations","POST",{provider,name,capabilities:caps,configuration:config,syncPolicy:{enabled:true,intervalMinutes:Number(interval),resources:inferResources(caps)}})); if(result){setMessage("Connexion créée en brouillon.");await load();}};
  const test=async()=>{if(!selected)return; const result=await run(()=>mutate(`/api/integrations/${selected.id}/test`,"POST")); if(result){setMessage(`Test: ${String(result.status??"terminé")}`);await reloadSelected();}};
  const authorize=async()=>{if(!selected)return; const result=await run(()=>mutate(`/api/integrations/${selected.id}/authorize`,"POST")); const url=result?.authorizationUrl; if(typeof url==="string") window.location.assign(url);};
  const saveSecret=async()=>{if(!selected||!secretValue)return; const result=await run(()=>mutate(`/api/integrations/${selected.id}/credentials`,"PUT",{kind:secretKind,value:secretValue,metadata:{source:"admin_ui"}})); if(result){setSecretValue("");setMessage("Credential chiffré enregistré.");await loadDetails(selected.id);}};
  const sync=async()=>{if(!selected)return; const result=await run(()=>mutate(`/api/integrations/${selected.id}/sync`,"POST",{resourceType,direction:"pull",triggerKind:"manual"})); if(result){setMessage(`Synchronisation mise en file: ${String(result.runId??"")}`);await loadDetails(selected.id);}};
  const saveMapping=async()=>{if(!selected)return; const result=await run(()=>mutate(`/api/integrations/${selected.id}/mappings`,"PUT",{resourceType,direction,clarityType,conflictPolicy,mapping:parseObject(mappingJson,"Mapping JSON invalide."),enabled:true})); if(result){setMessage("Mapping enregistré.");await loadDetails(selected.id);}};
  const resetCheckpoint=async()=>{if(!selected||!window.confirm(`Réinitialiser le checkpoint ${resourceType} ? Le prochain pull repartira du fournisseur.`))return; const result=await run(()=>mutate(`/api/integrations/${selected.id}/checkpoint`,"DELETE",{resourceType})); if(result){setMessage("Checkpoint réinitialisé.");await loadDetails(selected.id);}};
  const disable=async()=>{if(!selected||!window.confirm("Désactiver cette connexion ?"))return; const result=await run(()=>mutate(`/api/integrations/${selected.id}/disable`,"POST")); if(result){setMessage("Connexion désactivée.");await reloadSelected();}};
  const revoke=async()=>{if(!selected||!window.confirm("Révoquer définitivement les credentials de cette connexion ?"))return; const result=await run(()=>mutate(`/api/integrations/${selected.id}/revoke`,"POST")); if(result){setMessage("Connexion révoquée et credentials supprimés.");await reloadSelected();}};

  const providerChanged=(value:string)=>{setProvider(value);setName(`Connexion ${value}`);setConfiguration(DEFAULT_CONFIG[value]??"{}"); const item=catalog.find((entry)=>entry.provider===value); if(item)setCapabilities(item.capabilities.filter((cap)=>cap.endsWith(".read")||cap==="webhook.outbound").join(","));};

  return <section className={styles.shell} aria-label="Integration Manager v1.3">
    <div className={styles.header}><div><h2>Clarity CRM v1.3 — Integration Manager</h2><p>Connexions externes gouvernées, synchronisations, mappings et Health Center. Les fournisseurs restent des adaptateurs vers les modèles Clarity existants.</p></div><span className={styles.badge}>{items.length} connexion(s)</span></div>
    {error?<div className={`${styles.notice} ${styles.error}`} role="alert">{error}</div>:null}{message?<div className={styles.notice} role="status">{message}</div>:null}
    <div className={styles.layout}>
      <aside className={styles.panel}><h3>Connexions</h3><div className={styles.list}>{items.map((item)=><button type="button" key={item.id} className={`${styles.item} ${selectedId===item.id?styles.active:""}`} onClick={()=>setSelectedId(item.id)}><strong>{item.name}</strong><div className={styles.meta}>{item.provider} · {item.status}</div>{item.lastErrorMessage?<div className={styles.meta}>{item.lastErrorMessage}</div>:null}</button>)}</div>
        <hr/><h3>Nouvelle connexion</h3><form className={styles.form} onSubmit={(event)=>void create(event)}><label className={styles.label}>Fournisseur<select className={styles.select} value={provider} onChange={(event)=>providerChanged(event.target.value)}>{catalog.map((item)=><option key={item.provider} value={item.provider}>{item.label}</option>)}</select></label><label className={styles.label}>Nom<input className={styles.input} value={name} onChange={(event)=>setName(event.target.value)} required/></label><label className={styles.label}>Capacités<input className={styles.input} value={capabilities} onChange={(event)=>setCapabilities(event.target.value)}/></label><label className={styles.label}>Configuration JSON<textarea className={styles.textarea} value={configuration} onChange={(event)=>setConfiguration(event.target.value)}/></label><label className={styles.label}>Intervalle planifié (min)<input className={styles.input} type="number" min="5" max="10080" value={interval} onChange={(event)=>setInterval(event.target.value)}/></label><button className={styles.button} disabled={busy}>Créer</button></form></aside>
      <main className={styles.grid}>{selected?<>
        <article className={styles.card}><h3>{selected.name}</h3><div className={styles.row}><span className={styles.status}>{selected.status}</span><span className={styles.meta}>{selected.provider}</span></div><p className={styles.meta}>Capacités : {selected.capabilities.join(", ")||"aucune"}</p><p className={styles.meta}>Dernier succès : {formatDate(selected.lastSuccessAt)}</p><div className={styles.row}><button className={styles.button} disabled={busy} onClick={()=>void test()}>Tester</button>{selected.provider==="google"||selected.provider==="microsoft"?<button className={styles.button} disabled={busy} onClick={()=>void authorize()}>Autoriser OAuth</button>:null}<button className={styles.button} disabled={busy} onClick={()=>void loadDetails(selected.id)}>Actualiser</button><button className={styles.button} disabled={busy} onClick={()=>void disable()}>Désactiver</button><button className={`${styles.button} ${styles.danger}`} disabled={busy} onClick={()=>void revoke()}>Révoquer</button></div></article>
        <article className={styles.card}><h3>Credential manuel</h3><div className={styles.form}><label className={styles.label}>Type<select className={styles.select} value={secretKind} onChange={(event)=>setSecretKind(event.target.value)}><option value="client_secret">client_secret</option><option value="webhook_secret">webhook_secret</option><option value="bind_password">bind_password</option></select></label><label className={styles.label}>Valeur<input className={styles.input} type="password" autoComplete="new-password" value={secretValue} onChange={(event)=>setSecretValue(event.target.value)}/></label><button className={styles.button} disabled={busy||!secretValue} onClick={()=>void saveSecret()}>Enregistrer chiffré</button></div><div className={styles.meta}>{health?.credentials.map((item)=>item.kind).join(", ")||"Aucun credential enregistré"}</div></article>
        <article className={styles.card}><h3>Synchronisation / checkpoint</h3><div className={styles.form}><label className={styles.label}>Ressource<input className={styles.input} value={resourceType} onChange={(event)=>setResourceType(event.target.value)}/></label><div className={styles.row}><button className={styles.button} disabled={busy} onClick={()=>void sync()}>Synchroniser maintenant</button><button className={styles.button} disabled={busy} onClick={()=>void resetCheckpoint()}>Réinitialiser checkpoint</button></div></div></article>
        <article className={styles.card}><h3>Mapping</h3><div className={styles.form}><label className={styles.label}>Type Clarity<input className={styles.input} value={clarityType} onChange={(event)=>setClarityType(event.target.value)}/></label><label className={styles.label}>Direction<select className={styles.select} value={direction} onChange={(event)=>setDirection(event.target.value)}><option value="pull_only">pull_only</option><option value="push_only">push_only</option><option value="bidirectional">bidirectional</option></select></label><label className={styles.label}>Conflit<select className={styles.select} value={conflictPolicy} onChange={(event)=>setConflictPolicy(event.target.value)}><option value="external_wins">external_wins</option><option value="clarity_wins">clarity_wins</option><option value="manual">manual</option></select></label><label className={styles.label}>Mapping JSON<textarea className={styles.textarea} value={mappingJson} onChange={(event)=>setMappingJson(event.target.value)}/></label><button className={styles.button} disabled={busy} onClick={()=>void saveMapping()}>Enregistrer mapping</button></div><div className={styles.meta}>{mappings.map((item)=>`${item.resourceType}→${item.clarityType||"—"} (${item.conflictPolicy})`).join(" · ")||"Aucun mapping explicite"}</div></article>
        <article className={`${styles.card} ${styles.wide}`}><h3>Health Center</h3><div className={styles.grid}><div><h4 className={styles.sectionTitle}>Événements</h4><div className={`${styles.scroll} ${styles.list}`}>{health?.events.map((event,index)=><div className={styles.item} key={`${event.createdAt}-${index}`}><strong>{event.severity} · {event.code}</strong><div>{event.message}</div><div className={styles.meta}>{formatDate(event.createdAt)} · {event.correlationId}</div></div>)}</div></div><div><h4 className={styles.sectionTitle}>Runs récents</h4><div className={styles.scroll}><table className={styles.table}><thead><tr><th>Ressource</th><th>Statut</th><th>Reçu</th><th>Créé/MàJ/Échec</th></tr></thead><tbody>{health?.runs.map((item)=><tr key={item.id}><td>{item.resourceType}<div className={styles.meta}>{item.triggerKind}</div></td><td>{item.status}{item.errorCode?<div className={styles.meta}>{item.errorCode}</div>:null}</td><td>{item.received}</td><td>{item.created}/{item.updated}/{item.failed}</td></tr>)}</tbody></table></div></div></div></article>
      </>:<article className={styles.card}><h3>Aucune connexion</h3><p className={styles.meta}>Créez une connexion depuis le panneau de gauche.</p></article>}</main>
    </div>
  </section>;
}

function splitCsv(value:string){return value.split(",").map((item)=>item.trim()).filter(Boolean);}
function inferResources(capabilities:string[]){const out:string[]=[];if(capabilities.includes("mail.read"))out.push("mail");if(capabilities.includes("calendar.read"))out.push("calendar");if(capabilities.includes("contacts.read"))out.push("contacts");if(capabilities.includes("files.read"))out.push("files");if(capabilities.includes("directory.users.read"))out.push("directory.users");if(capabilities.includes("directory.groups.read"))out.push("directory.groups");return out;}
function parseObject(value:string,message:string){try{const parsed=JSON.parse(value) as unknown;if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed as Record<string,unknown>;}catch{}throw new Error(message);}
function formatDate(value:string|null|undefined){if(!value)return "—";const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString("fr-FR"):value;}
