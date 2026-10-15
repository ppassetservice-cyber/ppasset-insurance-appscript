/** Insurance TEST receipt and authenticated forwarding endpoint. Keeps the 31-column sheet. */
function insuranceQuoteReceiptFlex_(data) {
  function field(label, value, maxLength) {
    return {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        {type: 'text', text: label, color: '#8195AB', size: 'xs'},
        {
          type: 'text',
          text: String(value || 'ไม่ระบุ').slice(0, maxLength || 600),
          wrap: true,
          color: '#EDF5FF',
          size: 'sm'
        }
      ]
    };
  }

  return {
    type: 'flex',
    altText: 'ตรวจสอบข้อมูลคำขอเช็กเบี้ยประกัน ' + data.request_id,
    contents: {
      type: 'bubble',
      size: 'mega',
      styles: {
        body: {backgroundColor: '#071425'},
        footer: {backgroundColor: '#071425'}
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: 'PP ASSET SERVICE',
            size: 'xs',
            color: '#B9FF86',
            weight: 'bold'
          },
          {
            type: 'text',
            text: 'ตรวจสอบข้อมูลเช็กเบี้ยประกัน',
            size: 'lg',
            weight: 'bold',
            color: '#FFFFFF',
            wrap: true
          },
          field('เลขที่คำขอ', data.request_id),
          field('ชื่อ / เบอร์โทร', data.customer_name + ' / ' + data.customer_phone),
          field('รถ', data.vehicle_make + ' ' + data.vehicle_model + ' ' + data.vehicle_submodel),
          field('ปีจดทะเบียน / จังหวัด', data.registration_year + ' / ' + data.registration_province),
          field('การใช้งาน', data.usage_type),
          field('ประเภทประกัน', 'ชั้น ' + data.insurance_type),
          field('บริษัทที่สนใจ', data.preferred_insurers),
          field('ความต้องการเพิ่มเติม / หมายเหตุ', data.contact_note, 2000),
          {
            type: 'text',
            text: 'กรุณาตรวจสอบข้อมูลด้านบน แล้วกดยืนยัน เพื่อให้เจ้าหน้าที่จัดข้อเสนอเบี้ยและเปรียบเทียบความคุ้มครองให้คุณ',
            size: 'sm',
            color: '#B8C7DA',
            wrap: true
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#4D9F24',
            action: {
              type: 'message',
              label: 'ยืนยันข้อมูลถูกต้อง',
              text: 'ยืนยันข้อมูลประกันถูกต้อง\nเลขที่คำขอ: ' + data.request_id
            }
          },
          {
            type: 'text',
            text: 'หากต้องการแก้ไข พิมพ์แจ้งในแชทนี้ได้เลย',
            wrap: true,
            size: 'xs',
            color: '#B8C7DA',
            align: 'center'
          }
        ]
      }
    }
  };
}

/** Accept confirmations forwarded by the authenticated insurance webhook. */
function insuranceQuoteConfirmForwarded_(e) {
  function output(result) {
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var lock;
  var locked = false;

  try {
    var props = PropertiesService.getScriptProperties();
    var expectedKey = props.getProperty('INSURANCE_TEST_CONFIRM_FORWARD_KEY') || '';
    var params = e && e.parameters;

    if (
      expectedKey.length < 32 ||
      !params ||
      !params.key ||
      params.key.length !== 1 ||
      params.key[0] !== expectedKey
    ) {
      return output({ok: false});
    }

    if (
      !params.flow ||
      params.flow.length !== 1 ||
      params.flow[0] !== 'insurance-confirmation-v1' ||
      !e.postData ||
      typeof e.postData.contents !== 'string' ||
      e.postData.contents.length > 20000
    ) {
      return output({ok: false});
    }

    insuranceQuoteLineTestGuard_();

    if (props.getProperty('INSURANCE_TEST_LINE_LINK_ENABLED') !== 'true') {
      return output({ok: false});
    }

    var payload = JSON.parse(e.postData.contents);
    var event = payload && payload.event;

    if (
      payload.type !== 'insurance_confirmation' ||
      !event ||
      event.type !== 'message' ||
      !event.message ||
      event.message.type !== 'text' ||
      !event.source ||
      event.source.type !== 'user' ||
      !/^U[0-9a-f]{32}$/i.test(event.source.userId || '')
    ) {
      return output({ok: false});
    }

    var match = /^ยืนยันข้อมูลประกันถูกต้อง\s*\nเลขที่คำขอ:\s*(INS\d{6,}|INS-\d{8}-[A-F0-9]{16})\s*$/
      .exec(String(event.message.text || ''));

    if (!match) return output({ok: false});

    lock = LockService.getScriptLock();
    locked = lock.tryLock(10000);

    if (!locked) return output({ok: false, retry: true});

    var identity = {
      requestId: match[1],
      userId: event.source.userId
    };

    var row = insuranceQuoteLiffOwnedRow_(identity);
    var duplicate = row.data.request_status === 'CUSTOMER_CONFIRMED';

    if (!duplicate) {
      insuranceQuoteLineSet_(row, 'request_status', 'CUSTOMER_CONFIRMED');
      insuranceQuoteLineSet_(row, 'updated_at', new Date().toISOString());
      SpreadsheetApp.flush();
    }

    var ack = insuranceQuoteConfirmationAck_(row);

    return output({
      ok: true,
      requestId: identity.requestId,
      confirmed: true,
      duplicate: duplicate,
      acknowledged: ack.sent,
      retry: ack.retry
    });
  } catch (error) {
    console.warn('Insurance chat confirmation could not be completed');
    return output({ok: false, retry: true});
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** Resolve identity server-side; never trust a browser-supplied LINE user ID. */
function insuranceQuoteLiffOwner_(requestId, idToken) {
  insuranceQuoteLineTestGuard_();
  if(PropertiesService.getScriptProperties().getProperty('INSURANCE_TEST_LINE_LINK_ENABLED')!=='true')throw new Error('LINE TEST disabled');
  if(!/^(?:INS\d{6,}|INS-\d{8}-[A-F0-9]{16})$/.test(String(requestId||'')))throw new Error('Invalid request');
  var user=insuranceQuoteLineVerifiedUser_(idToken);
  return {requestId:String(requestId),userId:user.userId};
}

function insuranceQuoteLiffOwnedRow_(identity) {
  var row=insuranceQuoteLineRow_(identity.requestId);
  if(!row.data.line_user_id || row.data.line_user_id!==identity.userId)throw new Error('Owner mismatch');
  if(row.data.customer_receipt_status!=='ACCEPTED')throw new Error('Receipt not accepted');
  return row;
}

/** Read details only after verifying the linked LINE account. No keys or tokens in responses. */
function insuranceQuoteLiffReview_(requestId,idToken) {
  var identity=insuranceQuoteLiffOwner_(requestId,idToken);
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(10000))throw new Error('Busy');
  try {
    var row=insuranceQuoteLiffOwnedRow_(identity), detail={};
    ['request_id','customer_name','customer_phone','vehicle_make','vehicle_model','vehicle_submodel',
     'registration_year','registration_province','usage_type','insurance_type','preferred_insurers','contact_note'].forEach(function(k){detail[k]=String(row.data[k]||'');});
    return {ok:true,requestId:identity.requestId,detail:detail,confirmed:row.data.request_status==='CUSTOMER_CONFIRMED',acknowledged:row.data.line_link_status==='CUSTOMER_CONFIRMED_ACK_SENT'};
  } finally {lock.releaseLock();}
}

/** Only an explicit POST from the confirmation screen can write confirmation. */
function insuranceQuoteLiffConfirm_(requestId,idToken,confirmation) {
  if(confirmation!=='yes')throw new Error('Explicit confirmation required');
  var identity=insuranceQuoteLiffOwner_(requestId,idToken);
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(10000))throw new Error('Busy');
  try {
    var row=insuranceQuoteLiffOwnedRow_(identity);
    var duplicate=row.data.request_status==='CUSTOMER_CONFIRMED';
    if(!duplicate){
      insuranceQuoteLineSet_(row,'request_status','CUSTOMER_CONFIRMED');
      insuranceQuoteLineSet_(row,'updated_at',new Date().toISOString());
      SpreadsheetApp.flush();
    }
    var ack=insuranceQuoteConfirmationAck_(row);
    return {ok:true,requestId:identity.requestId,confirmed:true,duplicate:duplicate,acknowledged:ack.sent,retry:ack.retry};
  } finally {lock.releaseLock();}
}

/** Strict parameter cardinality for the LIFF review/confirmation endpoint. */
function insuranceQuoteLiffDispatch_(e) {
  var result;
  try {
    if(!e || !e.parameter || !e.postData || e.postData.length>20000)throw new Error('Invalid request');
    var confirm=e.parameter.flow==='insurance-confirm-liff-v1';
    if(!confirm && e.parameter.flow!=='insurance-review-liff-v1')throw new Error('Invalid flow');
    var params=e.parameters||{};
    ['flow','quote','idToken','format','requestId'].concat(confirm?['confirmation']:[]).forEach(function(k){
      if(!params[k] || params[k].length!==1)throw new Error('Invalid parameters');
    });
    if(e.parameter.format!=='bridge' || !/^[a-f0-9]{32}$/.test(e.parameter.requestId||''))throw new Error('Invalid bridge');
    result=confirm?insuranceQuoteLiffConfirm_(e.parameter.quote,e.parameter.idToken,e.parameter.confirmation):insuranceQuoteLiffReview_(e.parameter.quote,e.parameter.idToken);
  } catch(error) {
    result={ok:false,message:'ยังตรวจสอบหรือยืนยันคำขอนี้ไม่ได้ กรุณาใช้บัญชี LINE ที่รับรายละเอียดคำขอ แล้วลองอีกครั้ง หรือติดต่อ @pp.asset โดยแจ้งเลขที่คำขอ'};
  }
  return insuranceQuoteLineResult_(result,e);
}

/** Persist the acknowledgement retry key before sending; never resend an accepted acknowledgement. */
function insuranceQuoteConfirmationAck_(row) {
  if(row.data.line_link_status==='CUSTOMER_CONFIRMED_ACK_SENT')return {sent:true,retry:false};
  var config=insuranceQuoteLineTestGuard_();
  if(!config.sendEnabled || !config.accessToken)return {sent:false,retry:true};
  var props=PropertiesService.getScriptProperties(), key='INSURANCE_CONFIRM_ACK_'+row.data.request_id;
  var saved=props.getProperty(key), state=saved?JSON.parse(saved):null;
  if(!state){
    state={createdAt:Date.now(),retryKey:Utilities.getUuid(),body:JSON.stringify({to:row.data.line_user_id,messages:[{type:'text',text:'ยืนยันข้อมูลคำขอเช็กเบี้ยประกันเรียบร้อยแล้วค่ะ\nเลขที่คำขอ: '+row.data.request_id+'\nเจ้าหน้าที่จะตรวจสอบเบี้ยและความคุ้มครอง แล้วส่งข้อเสนอให้ในแชทนี้ค่ะ'}]})};
    props.setProperty(key,JSON.stringify(state));
  }
  // LINE retains retry keys for 24 hours; ambiguous older sends need staff review.
  if(Date.now()-state.createdAt>23*60*60*1000)return {sent:false,retry:false};
  try{
    var bot=UrlFetchApp.fetch('https://api.line.me/v2/bot/info',{headers:{Authorization:'Bearer '+config.accessToken.trim()},muteHttpExceptions:true});
    if(bot.getResponseCode()!==200 || JSON.parse(bot.getContentText()).premiumId!=='@pp.asset')return {sent:false,retry:true};
    var response=UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+config.accessToken.trim(),'X-Line-Retry-Key':state.retryKey},payload:state.body,muteHttpExceptions:true});
    var code=response.getResponseCode(), accepted=code===200;
    if(code===409){var headers=response.getAllHeaders();accepted=Object.keys(headers).some(function(k){return k.toLowerCase()==='x-line-accepted-request-id' && Boolean(headers[k]);});}
    if(!accepted)return {sent:false,retry:true};
    insuranceQuoteLineSet_(row,'line_link_status','CUSTOMER_CONFIRMED_ACK_SENT');
    insuranceQuoteLineSet_(row,'updated_at',new Date().toISOString());SpreadsheetApp.flush();props.deleteProperty(key);
    return {sent:true,retry:false};
  }catch(error){return {sent:false,retry:true};}
}

/** Run once in the insurance TEST editor; generates a forwarding key without logging it. */
function insuranceQuotePrepareConfirmKey() {
  insuranceQuoteLineTestGuard_();
  var props=PropertiesService.getScriptProperties(), name='INSURANCE_TEST_CONFIRM_FORWARD_KEY';
  var key=props.getProperty(name)||'';
  if(!key){key=(Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'');props.setProperty(name,key);}
  if(key.length<32)throw new Error('ค่า forwarding key เดิมสั้นเกินไป กรุณาตั้งค่าใหม่ใน Script Properties');
  var result={ok:true,hasForwardKey:true,sendEnabled:props.getProperty('INSURANCE_TEST_LINE_SEND_ENABLED')==='true'};
  console.log(JSON.stringify(result));return result;
}