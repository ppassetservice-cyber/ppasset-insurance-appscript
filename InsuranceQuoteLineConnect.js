/** Insurance quote LINE linking, TEST only. No loan or webhook integration. */

var PP_QUOTE_LINE_CONNECT = {

  spreadsheetId: '1XiknAuU9jOuWA2OiA3hcbrCot3PlV6tM5M59S8cf_Gg',

  sheetName: 'Insurance_Quote_Requests',

  liffId: '2011333776-7CCq2hRE',

  channelId: '2011333776',

  ttlSeconds: 600,

  version: 'insurance-line-link-v1'

};



function insuranceQuoteLineTestGuard_() {

  if (PP_QUOTE_REQUEST.spreadsheetId !== PP_QUOTE_LINE_CONNECT.spreadsheetId ||

      PP_QUOTE_REQUEST.sheetName !== PP_QUOTE_LINE_CONNECT.sheetName) {

    throw new Error('LINE สำหรับคำขอประกันรองรับเฉพาะฐาน TEST ที่กำหนด');

  }

  var config = insuranceQuoteLineConfig_();

  if (config.loginChannelId !== PP_QUOTE_LINE_CONNECT.channelId ||

      config.liffId !== PP_QUOTE_LINE_CONNECT.liffId ||

      config.liffUrl !== 'https://liff.line.me/' + PP_QUOTE_LINE_CONNECT.liffId) {

    throw new Error('การตั้งค่า LINE TEST ไม่ตรง กรุณาติดต่อเจ้าหน้าที่');

  }

  return config;

}



function insuranceQuoteLineHash_(value) {

  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)

    .map(function(b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');

}



function insuranceQuoteLineRow_(requestId) {

  if (!/^(?:INS\d{6,}|INS-\d{8}-[A-F0-9]{16})$/.test(String(requestId || ''))) throw new Error('เลขที่คำขอไม่ถูกต้อง');

  var sheet = SpreadsheetApp.openById(PP_QUOTE_LINE_CONNECT.spreadsheetId)

    .getSheetByName(PP_QUOTE_LINE_CONNECT.sheetName);

  if (!sheet) throw new Error('ไม่พบที่เก็บคำขอ TEST');

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];

  if (headers.length !== PP_QUOTE_REQUEST.headers.length ||

      headers.some(function(h, i) { return h !== PP_QUOTE_REQUEST.headers[i]; })) {

    throw new Error('โครงสร้างคำขอ TEST ไม่ตรง');

  }

  var count = sheet.getLastRow() - 1, rowNumber = 0;

  if (count > 0) sheet.getRange(2, 1, count, 1).getDisplayValues().forEach(function(row, i) {

    if (row[0] === requestId) {

      if (rowNumber) throw new Error('พบเลขที่คำขอซ้ำ กรุณาติดต่อเจ้าหน้าที่');

      rowNumber = i + 2;

    }

  });

  if (!rowNumber) throw new Error('ไม่พบคำขอที่ต้องการเชื่อม LINE');

  var values = sheet.getRange(rowNumber, 1, 1, headers.length).getDisplayValues()[0], data = {};

  headers.forEach(function(h, i) { data[h] = values[i]; });

  if (data.source_host !== 'TEST_APPS_SCRIPT' || data.source_channel !== 'INSURANCE_QUOTE_REQUEST_V1' ||

      data.consent !== 'TRUE') throw new Error('คำขอนี้ไม่ใช่คำขอประกัน TEST ที่อนุญาต');

  return {sheet: sheet, headers: headers, number: rowNumber, data: data};

}



function insuranceQuoteLineSet_(row, name, value) {

  var cell = row.sheet.getRange(row.number, row.headers.indexOf(name) + 1);

  cell.setNumberFormat('@');

  cell.setValue(/^[=+@-]/.test(String(value)) ? "'" + value : value);

  row.data[name] = String(value);

}



/** Called only after a quote has been saved. The random submission key proves possession. */

function webCreateInsuranceQuoteLineLink(requestId, submissionKey) {

  try {

    var config = insuranceQuoteLineTestGuard_();

    if (PropertiesService.getScriptProperties().getProperty('INSURANCE_TEST_LINE_LINK_ENABLED') !== 'true') {

      throw new Error('บันทึกคำขอแล้ว ส่วนเชื่อม LINE อยู่ระหว่างเตรียมทดสอบ');

    }

    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(String(submissionKey || ''))) throw new Error('รหัสคำขอไม่ถูกต้อง');

    var lock = LockService.getScriptLock();

    if (!lock.tryLock(10000)) throw new Error('ระบบกำลังทำงาน กรุณาลองใหม่');

    try {

      var row = insuranceQuoteLineRow_(String(requestId));

      if (row.data.submission_key !== submissionKey) throw new Error('ไม่สามารถยืนยันคำขอ กรุณาส่งคำขอจากหน้าเดิม');

      var ticket = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();

      var entry = {requestId: requestId, proof: insuranceQuoteLineHash_(submissionKey),

        expiresAt: Date.now() + PP_QUOTE_LINE_CONNECT.ttlSeconds * 1000, userId: row.data.line_user_id || ''};

      CacheService.getScriptCache().put('insurance-line-ticket:' + insuranceQuoteLineHash_(ticket),

        JSON.stringify(entry), PP_QUOTE_LINE_CONNECT.ttlSeconds);

      return {ok: true, requestId: requestId, expiresAt: entry.expiresAt,

        url: config.liffUrl + '?ticket=' + encodeURIComponent(ticket)};

    } finally { lock.releaseLock(); }

  } catch (error) {

    return {ok: false, message: error.message || 'ยังเตรียมลิงก์ LINE ไม่สำเร็จ กรุณาลองใหม่'};

  }

}



function insuranceQuoteLineTicket_(ticket) {

  if (!/^[a-f0-9]{64}$/.test(String(ticket || ''))) throw new Error('ลิงก์เชื่อม LINE ไม่ถูกต้อง');

  var key = 'insurance-line-ticket:' + insuranceQuoteLineHash_(ticket);

  var text = CacheService.getScriptCache().get(key), entry = text ? JSON.parse(text) : null;

  if (!entry || !entry.expiresAt || entry.expiresAt <= Date.now()) {

    throw new Error('ลิงก์หมดอายุ กรุณากลับไปหน้าแบบฟอร์มเดิมแล้วกดสร้างลิงก์ใหม่');

  }

  return {key: key, entry: entry};

}



function insuranceQuoteLineSaveTicket_(item) {

  var remaining = Math.floor((item.entry.expiresAt - Date.now()) / 1000);

  if (remaining < 1) throw new Error('ลิงก์หมดอายุ กรุณาสร้างลิงก์ใหม่');

  CacheService.getScriptCache().put(item.key, JSON.stringify(item.entry), remaining);

}



function insuranceQuoteLineVerifiedUser_(idToken) {

  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 10000) {

    throw new Error('ไม่พบข้อมูลยืนยันตัวตน LINE กรุณาเข้าสู่ระบบใหม่');

  }

  var response;

  try {

    response = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {

      method: 'post', contentType: 'application/x-www-form-urlencoded',

      payload: {id_token: idToken, client_id: PP_QUOTE_LINE_CONNECT.channelId},

      muteHttpExceptions: true

    });

  } catch (error) { throw new Error('ยังติดต่อ LINE ไม่สำเร็จ กรุณาลองใหม่'); }

  if (response.getResponseCode() !== 200) {

    var diagnosticType = 'OTHER';

    try {

      var diagnosticBody = JSON.parse(response.getContentText());

      var diagnosticDescription = String(diagnosticBody.error_description || '').toLowerCase();

      if (/expir/.test(diagnosticDescription)) diagnosticType = 'TOKEN_EXPIRED';

      else if (/audience|client_id|channel/.test(diagnosticDescription)) diagnosticType = 'CHANNEL_OR_CLIENT';

      else if (/signature/.test(diagnosticDescription)) diagnosticType = 'TOKEN_SIGNATURE';

      else if (/id_token|token/.test(diagnosticDescription)) diagnosticType = 'TOKEN_INVALID';

    } catch (_) {}

    console.warn('INSURANCE_VERIFY_DIAGNOSTIC HTTP=' +

      response.getResponseCode() + ' TYPE=' + diagnosticType);

    throw new Error('ยืนยันตัวตน LINE ไม่ผ่าน กรุณาเข้าสู่ระบบใหม่');

  }

  var user = JSON.parse(response.getContentText());

  if (user.iss !== 'https://access.line.me' || String(user.aud) !== PP_QUOTE_LINE_CONNECT.channelId ||

      !Number.isFinite(Number(user.exp)) || Number(user.exp) <= Date.now() / 1000 ||

      !/^U[a-f0-9]{32}$/.test(String(user.sub || ''))) {

    throw new Error('ข้อมูลยืนยันตัวตน LINE ไม่ตรง');

  }

  return {userId: user.sub, name: String(user.name || '').slice(0, 200)};

}



/** Retry key and exact message body remain fixed for the lifetime of this ticket. */

function insuranceQuoteLineReceipt_(row, item, config) {

  if (row.data.customer_receipt_status === 'ACCEPTED') return 'ACCEPTED';

  if (!config.sendEnabled) {

    insuranceQuoteLineSet_(row, 'customer_receipt_status', 'NOT_SENT_TEST_DISABLED');

    return 'NOT_SENT_TEST_DISABLED';

  }

  if (!config.accessToken) return 'NOT_SENT_CONFIG';

  // Check the actual OA before any push, even if an access token was changed later.

  try {

    var bot = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {

      headers: {Authorization: 'Bearer ' + config.accessToken.trim()}, muteHttpExceptions: true

    });

    if (bot.getResponseCode() !== 200 || JSON.parse(bot.getContentText()).premiumId !== '@pp.asset') {

      insuranceQuoteLineSet_(row, 'customer_receipt_status', 'NOT_SENT_OA_MISMATCH');

      return 'NOT_SENT_OA_MISMATCH';

    }

    var props=PropertiesService.getScriptProperties(), receiptKey='INSURANCE_RECEIPT_PUSH_'+row.data.request_id;

    var savedReceipt=props.getProperty(receiptKey);

    if(savedReceipt) item.entry.receipt=JSON.parse(savedReceipt);

    if (!item.entry.receipt) {

      item.entry.receipt = {createdAt: Date.now(), retryKey: Utilities.getUuid(), body: JSON.stringify({

        to: item.entry.userId, messages: [insuranceQuoteReceiptFlex_(row.data)]

      })};

      props.setProperty(receiptKey,JSON.stringify(item.entry.receipt));

      insuranceQuoteLineSaveTicket_(item);

    }

    if(!item.entry.receipt.createdAt || Date.now()-item.entry.receipt.createdAt>23*60*60*1000){insuranceQuoteLineSet_(row,'customer_receipt_status','PENDING_MANUAL_REVIEW');return 'PENDING_MANUAL_REVIEW';}

    var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {

      method: 'post', contentType: 'application/json',

      headers: {Authorization: 'Bearer ' + config.accessToken.trim(), 'X-Line-Retry-Key': item.entry.receipt.retryKey},

      payload: item.entry.receipt.body, muteHttpExceptions: true

    });

    var code = response.getResponseCode(), accepted = code === 200;

    if (code === 409) {

      var headers = response.getAllHeaders();

      accepted = Object.keys(headers).some(function(k) {

        return k.toLowerCase() === 'x-line-accepted-request-id' && Boolean(headers[k]);

      });

    }

    var status = accepted ? 'ACCEPTED' : 'FAILED_HTTP_' + code;

    insuranceQuoteLineSet_(row, 'customer_receipt_status', status);

    if(accepted){SpreadsheetApp.flush();props.deleteProperty(receiptKey);}

    return status;

  } catch (error) {

    insuranceQuoteLineSet_(row, 'customer_receipt_status', 'PENDING_RETRY');

    return 'PENDING_RETRY';

  }

}



function insuranceQuoteLineAttach_(ticket, idToken, consent) {

  var config = insuranceQuoteLineTestGuard_();

  if (PropertiesService.getScriptProperties().getProperty('INSURANCE_TEST_LINE_LINK_ENABLED') !== 'true') {

    throw new Error('ส่วนเชื่อม LINE TEST ยังไม่เปิดใช้งาน');

  }

  if (consent !== 'yes') throw new Error('กรุณายินยอมให้เชื่อม LINE กับคำขอก่อน');

  insuranceQuoteLineTicket_(ticket); // Reject missing/expired tickets before calling LINE.

  var user = insuranceQuoteLineVerifiedUser_(idToken);

  var lock = LockService.getScriptLock();

  if (!lock.tryLock(10000)) throw new Error('ระบบกำลังทำงาน กรุณาลองใหม่');

  try {

    var item = insuranceQuoteLineTicket_(ticket), row = insuranceQuoteLineRow_(item.entry.requestId);

    if (insuranceQuoteLineHash_(row.data.submission_key) !== item.entry.proof) throw new Error('คำขอไม่ตรงกับลิงก์');

    if ((item.entry.userId && item.entry.userId !== user.userId) ||

        (row.data.line_user_id && row.data.line_user_id !== user.userId)) {

      throw new Error('คำขอนี้เชื่อมกับบัญชี LINE อื่นแล้ว กรุณาติดต่อเจ้าหน้าที่');

    }

    // The first verified identity consumes the ticket; only that identity may repeat it.

    item.entry.userId = user.userId;

    insuranceQuoteLineSaveTicket_(item);

    insuranceQuoteLineSet_(row, 'line_user_id', user.userId);

    insuranceQuoteLineSet_(row, 'line_display_name', user.name);

    if(row.data.line_link_status!=='CUSTOMER_CONFIRMED_ACK_SENT')insuranceQuoteLineSet_(row, 'line_link_status', 'LINKED_LIFF_CONSENT_V1');

    insuranceQuoteLineSet_(row, 'updated_at', new Date().toISOString());

    SpreadsheetApp.flush();

    var receiptStatus = insuranceQuoteLineReceipt_(row, item, config);

    SpreadsheetApp.flush();

    return {ok: true, requestId: row.data.request_id, receiptStatus: receiptStatus};

  } finally { lock.releaseLock(); }

}



function insuranceQuoteLineEscape_(text) {

  return String(text || '').replace(/[&<>"']/g, function(c) {

    return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c];

  });

}



function insuranceQuoteLineResult_(result, e) {

  if(e && e.parameter && e.parameter.format==='bridge'){

    var correlation=String(e.parameter.requestId||'');

    if(!/^[a-f0-9]{32}$/.test(correlation)) return ContentService.createTextOutput('Invalid request');

    var payload=JSON.stringify({type:'pp-insurance-receipt',requestId:correlation,result:result}).replace(/</g,'\\\u003c');

    return HtmlService.createHtmlOutput('<!doctype html><html><body><script>window.top.postMessage('+payload+',"https://ppassetservice-cyber.github.io");</'+'script></body></html>').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  }

  var message = result.ok ? 'เชื่อม LINE กับคำขอเช็กเบี้ยเรียบร้อยแล้ว' : 'ยังเชื่อม LINE ไม่สำเร็จ';

  var detail = result.ok ? 'เลขที่คำขอ: ' + result.requestId : result.message;

  if (result.ok) detail += result.receiptStatus === 'ACCEPTED' ?

    '\nLINE รับคำยืนยันเข้าระบบแล้ว กรุณาตรวจข้อความในแชท @pp.asset' :

    result.receiptStatus === 'NOT_SENT_TEST_DISABLED' ? '\nอยู่ระหว่างทดสอบ จึงยังไม่ได้ส่งข้อความยืนยัน' :

    '\nบันทึกบัญชี LINE แล้ว แต่ยังยืนยันการส่งข้อความไม่ได้';

  return HtmlService.createHtmlOutput('<!doctype html><html lang="th"><head><meta charset="utf-8">' +

    '<meta name="referrer" content="no-referrer"><style>body{font:17px Tahoma,sans-serif;background:#071B34;' +

    'color:#D7F3FF;margin:0;padding:32px 20px}main{max-width:560px;margin:auto}h1{font-size:24px;' +

    'color:#67C9FD}p{line-height:1.8;white-space:pre-line}a{color:#67C9FD}</style></head><body><main><h1>' +

    insuranceQuoteLineEscape_(message) + '</h1><p>' + insuranceQuoteLineEscape_(detail) + '</p>' +

    '<p><a href="https://line.me/R/ti/p/%40pp.asset" target="_top" rel="noopener noreferrer">เปิด LINE OA @pp.asset</a></p>' +

    '<p>กลับไปหน้าแบบฟอร์มเดิมได้ โดยไม่ต้องส่งคำขอซ้ำ</p></main></body></html>')

    .setTitle('TEST — เชื่อม LINE | PP Asset Service').addMetaTag('viewport', 'width=device-width,initial-scale=1');

}



/** Only this TEST flow is accepted. This is not a LINE webhook handler. */

function doPost(e) {

  if(e && e.parameter && /^(insurance-review-liff-v1|insurance-confirm-liff-v1)$/.test(e.parameter.flow||''))return insuranceQuoteLiffDispatch_(e);

  if(e && e.parameter && e.parameter.flow==='insurance-confirmation-v1')return insuranceQuoteConfirmForwarded_(e);

  var result;

  try {

    if (!e || !e.parameter || e.parameter.flow !== PP_QUOTE_LINE_CONNECT.version ||

        !e.postData || e.postData.length > 20000) throw new Error('รูปแบบคำขอไม่ถูกต้อง');

    var params = e.parameters || {};

    ['flow', 'ticket', 'idToken', 'consent'].forEach(function(k) {

      if (!params[k] || params[k].length !== 1) throw new Error('รูปแบบคำขอไม่ถูกต้อง');

    });

    result = insuranceQuoteLineAttach_(e.parameter.ticket, e.parameter.idToken, e.parameter.consent);

  } catch (error) {

    var safeMessages = ["LINE สำหรับคำขอประกันรองรับเฉพาะฐาน TEST ที่กำหนด","การตั้งค่า LINE TEST ไม่ตรง กรุณาติดต่อเจ้าหน้าที่","เลขที่คำขอไม่ถูกต้อง","ไม่พบที่เก็บคำขอ TEST","โครงสร้างคำขอ TEST ไม่ตรง","พบเลขที่คำขอซ้ำ กรุณาติดต่อเจ้าหน้าที่","ไม่พบคำขอที่ต้องการเชื่อม LINE","คำขอนี้ไม่ใช่คำขอประกัน TEST ที่อนุญาต","บันทึกคำขอแล้ว ส่วนเชื่อม LINE อยู่ระหว่างเตรียมทดสอบ","รหัสคำขอไม่ถูกต้อง","ระบบกำลังทำงาน กรุณาลองใหม่","ไม่สามารถยืนยันคำขอ กรุณาส่งคำขอจากหน้าเดิม","ลิงก์เชื่อม LINE ไม่ถูกต้อง","ลิงก์หมดอายุ กรุณากลับไปหน้าแบบฟอร์มเดิมแล้วกดสร้างลิงก์ใหม่","ลิงก์หมดอายุ กรุณาสร้างลิงก์ใหม่","ไม่พบข้อมูลยืนยันตัวตน LINE กรุณาเข้าสู่ระบบใหม่","ยังติดต่อ LINE ไม่สำเร็จ กรุณาลองใหม่","ยืนยันตัวตน LINE ไม่ผ่าน กรุณาเข้าสู่ระบบใหม่","ข้อมูลยืนยันตัวตน LINE ไม่ตรง","ส่วนเชื่อม LINE TEST ยังไม่เปิดใช้งาน","กรุณายินยอมให้เชื่อม LINE กับคำขอก่อน","คำขอไม่ตรงกับลิงก์","คำขอนี้เชื่อมกับบัญชี LINE อื่นแล้ว กรุณาติดต่อเจ้าหน้าที่","รูปแบบคำขอไม่ถูกต้อง"];

    console.warn("INSURANCE_LINK_DIAGNOSTIC: " + (safeMessages.indexOf(String(error && error.message)) >= 0 ? error.message : "UNCLASSIFIED"));

    // Never return tokens, raw LINE responses, or stack traces to the browser/log.

    result = {ok: false, message: 'กรุณากลับไปหน้าแบบฟอร์มเดิม กดสร้างลิงก์ใหม่ แล้วลองเชื่อม LINE อีกครั้ง หากยังไม่สำเร็จให้ติดต่อ @pp.asset โดยแจ้งเลขที่คำขอ'};

  }

  return insuranceQuoteLineResult_(result, e);

}


