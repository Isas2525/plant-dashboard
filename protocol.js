/* Snapshot decoder for BluetoothMonitor.h. Incomplete frames never become readings. */
(function(root){
  const fields=['soil_pct','soil_V','soil_raw','temp_C','rh_pct','co2_ppm','micA_dBFS','micB_dBFS','micC_dBFS','micD_dBFS'];
  class SnapshotDecoder{
    constructor(onSample){this.onSample=onSample;this.reset();}
    reset(){this.buffer='';this.pending=null;this.started=0;}
    feed(text,now=Date.now()){
      if(this.pending&&now-this.started>15000)this.pending=null;
      this.buffer+=text;
      if(this.buffer.length>2048){this.reset();return;}
      let end;
      while((end=this.buffer.indexOf('\n'))>=0){
        const line=this.buffer.slice(0,end).trim();this.buffer=this.buffer.slice(end+1);
        const split=line.indexOf('=');if(split<0)continue;
        const key=line.slice(0,split),value=line.slice(split+1);
        if(key==='sample'){
          this.pending=/^\d+$/.test(value)?{sample:Number(value)}:null;this.started=now;continue;
        }
        if(!this.pending)continue;
        if(fields.includes(key)){
          if(value==='NA')this.pending[key]=null;
          else if(/^-?\d+(\.\d+)?$/.test(value)&&Number.isFinite(Number(value)))this.pending[key]=Number(value);
          else this.pending=null;
        }else if(key==='audio'){
          if(['off','listening','recording','fault'].includes(value)&&fields.every(k=>Object.hasOwn(this.pending,k)))
            this.onSample({...this.pending,audio:value,time:now});
          this.pending=null;
        }
      }
    }
  }
  root.SnapshotDecoder=SnapshotDecoder;
  if(typeof module!=='undefined')module.exports={SnapshotDecoder,fields};
})(globalThis);
