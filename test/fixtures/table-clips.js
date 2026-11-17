'use strict';
// 표 붙여넣기 시험의 클립보드 꼴 — 손으로 적은 것이다 (실제 프로그램이 클립보드에 싣는 HTML 꼴을 따랐다).
// 크로미움은 윈도우 CF_HTML 의 머리(Version:·StartHTML: …)를 떼고 <html> 문서 통째를 text/html 로 준다.
//   EXCEL  — 엑셀 365 (윈도우): <style> 의 .xl65 같은 class 규칙, td{…border:none}, <col width=64 style='width:48pt'>,
//            합친 칸(colspan·rowspan), 숨긴 열(display:none), x:num 숫자, 한글, 칸 안 줄바꿈(<br style='mso-data-placement:same-cell'>),
//            채우기 색, 테두리 .5pt solid windowtext · 1.5pt
//   SHEETS — 구글 시트: <google-sheets-html-origin>, 인라인 style, colgroup 너비, data-sheets-value
//   WORD   — 워드: MsoTableGrid, border:solid windowtext 1.0pt, mso-border-alt, 칸 안의 <p class=MsoNormal>, <o:p></o:p>, 표 앞뒤 문단
//   HWP    — 한글(한컴): 대문자 태그 <TABLE border="1" …>, <P CLASS=HStyle0>, <SPAN STYLE='font-family:"맑은 고딕"'>
//   WEB    — 보통 웹 표: class·id·data-*·onclick, 링크, <img>, 앞뒤 글
//   HOSTILE — 바깥을 부르거나 실행되려는 것들 (주소는 지어낸 x.example)
// 엑셀·워드는 줄바꿈이 CRLF 다 — 그대로 흉내 낸다.
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

const EXCEL_HTML = crlf(String.raw`<html xmlns:v="urn:schemas-microsoft-com:vml"
xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:x="urn:schemas-microsoft-com:office:excel"
xmlns="http://www.w3.org/TR/REC-html40">

<head>
<meta http-equiv=Content-Type content="text/html; charset=utf-8">
<meta name=ProgId content=Excel.Sheet>
<meta name=Generator content="Microsoft Excel 15">
<link id=Main-File rel=Main-File
href="file:///C:/Users/x/AppData/Local/Temp/msohtmlclip1/01/clip.htm">
<link rel=File-List
href="file:///C:/Users/x/AppData/Local/Temp/msohtmlclip1/01/clip_filelist.xml">
<style>
<!--table
	{mso-displayed-decimal-separator:"\.";
	mso-displayed-thousand-separator:"\,";}
@page
	{margin:.75in .7in .75in .7in;
	mso-header-margin:.3in;
	mso-footer-margin:.3in;}
.font5
	{color:windowtext;
	font-size:8.0pt;
	font-weight:400;
	font-style:normal;
	text-decoration:none;
	font-family:"맑은 고딕", monospace;
	mso-font-charset:129;}
tr
	{mso-height-source:auto;
	mso-ruby-visibility:none;}
col
	{mso-width-source:auto;
	mso-ruby-visibility:none;}
br
	{mso-data-placement:same-cell;}
.style0
	{mso-number-format:General;
	text-align:general;
	vertical-align:middle;
	white-space:nowrap;
	mso-rotate:0;
	mso-background-source:auto;
	mso-pattern:auto;
	color:black;
	font-size:11.0pt;
	font-weight:400;
	font-style:normal;
	text-decoration:none;
	font-family:"맑은 고딕", monospace;
	mso-font-charset:129;
	border:none;
	mso-protection:locked visible;
	mso-style-name:표준;
	mso-style-id:0;}
td
	{mso-style-parent:style0;
	padding-top:1px;
	padding-right:1px;
	padding-left:1px;
	mso-ignore:padding;
	color:black;
	font-size:11.0pt;
	font-weight:400;
	font-style:normal;
	text-decoration:none;
	font-family:"맑은 고딕", monospace;
	mso-font-charset:129;
	mso-number-format:General;
	text-align:general;
	vertical-align:middle;
	border:none;
	mso-background-source:auto;
	mso-pattern:auto;
	mso-protection:locked visible;
	white-space:nowrap;
	mso-rotate:0;}
.xl65
	{mso-style-parent:style0;
	font-weight:700;
	text-align:center;
	border:.5pt solid windowtext;
	background:#FFFF00;
	mso-pattern:black none;}
.xl66
	{mso-style-parent:style0;
	border:.5pt solid windowtext;}
.xl67
	{mso-style-parent:style0;
	mso-number-format:"\#\,\#\#0";
	border:.5pt solid windowtext;}
.xl68
	{mso-style-parent:style0;
	text-align:center;
	border-top:.5pt solid windowtext;
	border-right:none;
	border-bottom:1.5pt solid windowtext;
	border-left:.5pt solid windowtext;
	white-space:normal;}
ruby
	{ruby-align:left;}
rt
	{color:windowtext;
	font-size:8.0pt;
	font-weight:400;
	font-style:normal;
	text-decoration:none;
	font-family:"맑은 고딕", monospace;
	mso-font-charset:129;
	mso-char-type:none;
	display:none;}
-->
</style>
</head>

<body link="#0563C1" vlink="#954F72">

<table border=0 cellpadding=0 cellspacing=0 width=256 style='border-collapse:
 collapse;width:192pt'>
<!--StartFragment-->
 <col width=64 span=2 style='width:48pt'>
 <col width=0 style='display:none;mso-width-source:userset;mso-width-alt:0'>
 <col width=128 style='mso-width-source:userset;mso-width-alt:4096;width:96pt'>
 <tr height=18 style='height:13.5pt'>
  <td height=18 class=xl65 width=64 style='height:13.5pt;width:48pt'>이름</td>
  <td class=xl65 width=64 style='border-left:none;width:48pt'>부서</td>
  <td class=xl65 width=0 style='display:none'>숨김열</td>
  <td class=xl65 width=128 style='border-left:none;width:96pt'>금액</td>
 </tr>
 <tr height=36 style='height:27.0pt'>
  <td height=36 class=xl66 style='height:27.0pt;border-top:none'>김민수</td>
  <td rowspan=2 class=xl68 style='border-top:none'>영업<br style='mso-data-placement:same-cell;'>1팀</td>
  <td class=xl66 style='display:none'>비밀</td>
  <td class=xl67 align=right style='border-top:none;border-left:none'
  x:num="1200000">1,200,000</td>
 </tr>
 <tr height=18 style='height:13.5pt'>
  <td height=18 class=xl66 style='height:13.5pt;border-top:none'>홍<font
  class="font5">길동</font></td>
  <td class=xl66 style='display:none'>비밀2</td>
  <td class=xl67 align=right style='border-top:none;border-left:none'
  x:num="800000">800,000</td>
 </tr>
 <tr height=18 style='height:13.5pt'>
  <td colspan=2 height=18 class=xl65 style='height:13.5pt'>합계</td>
  <td class=xl66 style='display:none'>&nbsp;</td>
  <td class=xl67 align=right style='border-top:none;border-left:none'
  x:num="2000000" x:fmla="=SUM(D2:D3)">2,000,000</td>
 </tr>
<!--EndFragment-->
</table>

</body>

</html>
`);
const EXCEL_TEXT = '이름\t부서\t금액\r\n김민수\t"영업\n1팀"\t1,200,000\r\n홍길동\t\t800,000\r\n합계\t\t2,000,000\r\n';

/** 엑셀 빈 칸 (서식도 테두리도 없는 칸 둘) — 예전처럼 아무 표도 안 넣는다 */
const EXCEL_EMPTY_HTML = crlf(String.raw`<html xmlns:v="urn:schemas-microsoft-com:vml"
xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:x="urn:schemas-microsoft-com:office:excel"
xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv=Content-Type content="text/html; charset=utf-8">
<meta name=ProgId content=Excel.Sheet>
<style>
<!--td
	{mso-style-parent:style0;
	color:black;
	font-size:11.0pt;
	border:none;
	white-space:nowrap;}
-->
</style>
</head>
<body link="#0563C1" vlink="#954F72">
<table border=0 cellpadding=0 cellspacing=0 width=128 style='border-collapse:
 collapse;width:96pt'>
<!--StartFragment-->
 <col width=64 span=2 style='width:48pt'>
 <tr height=18 style='height:13.5pt'>
  <td height=18 width=64 style='height:13.5pt;width:48pt'></td>
  <td width=64 style='width:48pt'></td>
 </tr>
<!--EndFragment-->
</table>
</body>
</html>
`);

/** 엑셀 빈 칸이지만 테두리를 그어 둔 것 — 빈 표 틀로 넣는다 */
const EXCEL_EMPTY_BORDER_HTML = EXCEL_EMPTY_HTML
  .replace('white-space:nowrap;}', 'white-space:nowrap;}\r\n.xl66\r\n\t{mso-style-parent:style0;\r\n\tborder:.5pt solid windowtext;}')
  .replace("<td height=18 width=64 style='height:13.5pt;width:48pt'></td>", "<td height=18 class=xl66 width=64 style='height:13.5pt;width:48pt'>&nbsp;</td>")
  .replace("<td width=64 style='width:48pt'></td>", "<td class=xl66 width=64 style='border-left:none;width:48pt'>&nbsp;</td>");

const SHEETS_HTML = String.raw`<meta charset="utf-8"><google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}br {mso-data-placement:same-cell;}--></style><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1" style="table-layout:fixed;font-size:10pt;font-family:Arial;width:0px;border-collapse:collapse;border:none" data-sheets-root="1" data-sheets-baot="1"><colgroup><col width="120"/><col width="80"/></colgroup><tbody><tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;background-color:#d9ead3;font-weight:bold;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;품목&quot;}">품목</td><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;background-color:#d9ead3;font-weight:bold;text-align:center;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;수량&quot;}">수량</td></tr><tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;font-style:italic;text-decoration:underline line-through;color:#ff0000;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;사과&quot;}">사과</td><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;text-align:right;" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:12}">12</td></tr><tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;border-bottom:2px solid #000000;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;배&quot;}" data-sheets-hyperlink="https://example.invalid/pear"><a class="in-cell-link" href="https://example.invalid/pear" target="_blank">배</a></td><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;text-align:right;" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:7}" data-sheets-formula="=R[-1]C-5">7</td></tr></tbody></table></google-sheets-html-origin>`;
const SHEETS_TEXT = '품목\t수량\n사과\t12\n배\t7';

const WORD_HTML = crlf(String.raw`<html xmlns:v="urn:schemas-microsoft-com:vml"
xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:w="urn:schemas-microsoft-com:office:word"
xmlns:m="http://schemas.microsoft.com/office/2004/12/omml"
xmlns="http://www.w3.org/TR/REC-html40">

<head>
<meta http-equiv=Content-Type content="text/html; charset=utf-8">
<meta name=ProgId content=Word.Document>
<meta name=Generator content="Microsoft Word 15">
<meta name=Originator content="Microsoft Word 15">
<link rel=File-List
href="file:///C:/Users/x/AppData/Local/Temp/msohtmlclip1/01/clip_filelist.xml">
<!--[if gte mso 9]><xml>
 <o:OfficeDocumentSettings>
  <o:AllowPNG/>
 </o:OfficeDocumentSettings>
</xml><![endif]-->
<style>
<!--
 /* Font Definitions */
 @font-face
	{font-family:"맑은 고딕";
	panose-1:2 11 5 3 2 0 0 2 0 4;
	mso-font-charset:129;}
 /* Style Definitions */
 p.MsoNormal, li.MsoNormal, div.MsoNormal
	{mso-style-unhide:no;
	margin:0cm;
	text-align:justify;
	text-justify:inter-ideograph;
	mso-pagination:none;
	word-break:break-hangul;
	font-size:10.0pt;
	font-family:"맑은 고딕";}
.MsoChpDefault
	{mso-style-type:export-only;
	font-family:"맑은 고딕";}
@page WordSection1
	{size:595.3pt 841.9pt;
	margin:3.0cm 72.0pt 72.0pt 72.0pt;}
div.WordSection1
	{page:WordSection1;}
-->
</style>
</head>

<body lang=KO style='tab-interval:40.0pt;word-wrap:break-word'>
<!--StartFragment-->

<p class=MsoNormal><span lang=EN-US>회의 안건<o:p></o:p></span></p>

<table class=MsoTableGrid border=1 cellspacing=0 cellpadding=0
 style='border-collapse:collapse;border:none;mso-border-alt:solid windowtext .5pt;
 mso-yfti-tbllook:1184;mso-padding-alt:0cm 5.4pt 0cm 5.4pt'>
 <tr style='mso-yfti-irow:0;mso-yfti-firstrow:yes'>
  <td width=301 valign=top style='width:225.4pt;border:solid windowtext 1.0pt;
  mso-border-alt:solid windowtext .5pt;background:#D9E2F3;mso-background-themecolor:
  accent1;mso-background-themetint:51;padding:0cm 5.4pt 0cm 5.4pt'>
  <p class=MsoNormal align=center style='text-align:center'><b><span
  style='font-family:"맑은 고딕"'>항목<o:p></o:p></span></b></p>
  </td>
  <td width=301 valign=top style='width:225.4pt;border:solid windowtext 1.0pt;
  border-left:none;mso-border-left-alt:solid windowtext .5pt;mso-border-alt:
  solid windowtext .5pt;padding:0cm 5.4pt 0cm 5.4pt'>
  <p class=MsoNormal><span lang=EN-US style='color:red'>Q4 </span>예산<o:p></o:p></p>
  </td>
 </tr>
 <tr style='mso-yfti-irow:1;mso-yfti-lastrow:yes'>
  <td width=301 valign=top style='width:225.4pt;border:solid windowtext 1.0pt;
  border-top:none;mso-border-top-alt:solid windowtext .5pt;mso-border-alt:solid windowtext .5pt;
  padding:0cm 5.4pt 0cm 5.4pt'>
  <p class=MsoNormal><span lang=EN-US><o:p>&nbsp;</o:p></span></p>
  </td>
  <td width=301 valign=top style='width:225.4pt;border-top:none;border-left:
  none;border-bottom:solid windowtext 1.0pt;border-right:solid windowtext 1.0pt;
  mso-border-top-alt:solid windowtext .5pt;mso-border-left-alt:solid windowtext .5pt;
  mso-border-alt:solid windowtext .5pt;padding:0cm 5.4pt 0cm 5.4pt'>
  <p class=MsoNormal><i>검토 중</i><o:p></o:p></p>
  </td>
 </tr>
</table>

<p class=MsoNormal><span lang=EN-US><o:p>&nbsp;</o:p></span></p>

<!--EndFragment-->
</body>

</html>
`);
const WORD_TEXT = '회의 안건\r\n항목\tQ4 예산\r\n\t검토 중\r\n\r\n';

const HWP_HTML = String.raw`<!--StartFragment--><HTML>
<HEAD>
<META NAME="Generator" CONTENT="Hancom HWP 10.0.0.0">
<STYLE type="text/css">
<!--
p.HStyle0
	{style-name:"바탕글"; margin-left:0.0pt; margin-right:0.0pt; margin-top:0.0pt; margin-bottom:0.0pt; text-align:justify; text-indent:0.0pt; line-height:160%; font-size:10.0pt; font-family:함초롬바탕; letter-spacing:0; font-weight:"normal"; font-style:"normal"; color:#000000;}
-->
</STYLE>
</HEAD>
<BODY>
<TABLE border="1" cellspacing="0" cellpadding="0" style='border-collapse:collapse;border:none;'>
<TR>
	<TD valign="middle" style='width:113px;height:28px;border-left:solid #000000 0.4pt;border-right:solid #000000 0.4pt;border-top:solid #000000 0.4pt;border-bottom:double #000000 1.4pt;background:#e5e5e5;padding:1.4pt 5.1pt 1.4pt 5.1pt'>
<P CLASS=HStyle0 STYLE='text-align:center;'><SPAN STYLE='font-family:"맑은 고딕";font-weight:"bold"'>구분</SPAN></P>
	</TD>
	<TD valign="middle" style='width:227px;height:28px;border-left:solid #000000 0.4pt;border-right:solid #000000 0.4pt;border-top:solid #000000 0.4pt;border-bottom:double #000000 1.4pt;background:#e5e5e5;padding:1.4pt 5.1pt 1.4pt 5.1pt'>
<P CLASS=HStyle0 STYLE='text-align:center;'><SPAN STYLE='font-family:"맑은 고딕"'>내용</SPAN></P>
	</TD>
</TR>
<TR>
	<TD valign="middle" style='width:113px;height:28px;border-left:solid #000000 0.4pt;border-right:solid #000000 0.4pt;border-top:none;border-bottom:solid #000000 0.4pt;padding:1.4pt 5.1pt 1.4pt 5.1pt'>
<P CLASS=HStyle0><SPAN STYLE='font-family:"맑은 고딕"'>일정</SPAN></P>
	</TD>
	<TD valign="middle" style='width:227px;height:28px;border-left:solid #000000 0.4pt;border-right:solid #000000 0.4pt;border-top:none;border-bottom:solid #000000 0.4pt;padding:1.4pt 5.1pt 1.4pt 5.1pt'>
<P CLASS=HStyle0><SPAN STYLE='font-family:"맑은 고딕";color:#0000ff'>11월 20일</SPAN></P>
	</TD>
</TR>
</TABLE>
</BODY>
</HTML>
<!--EndFragment-->`;
const HWP_TEXT = '구분\t내용\r\n일정\t11월 20일\r\n';

const WEB_HTML = String.raw`<html><body><!--StartFragment--><h3 class="title">지점 목록</h3><table class="data-grid" id="t1" border="1" data-id="9" onclick="alert(1)" style="width:150%"><caption>2026년</caption><thead><tr><th class="h" scope="col">지점</th><th>주소</th></tr></thead><tbody><tr class="odd"><td class="c" bgcolor="#eeeeee">강남</td><td><a href="https://example.invalid/gangnam" class="lnk" target="_blank" rel="noopener" onclick="track()">지도</a> <img src="https://x.example/pin.png" alt="핀" width="12"></td></tr><tr><td colspan="2"><a href="mailto:help@example.invalid">문의</a> · <a href="javascript:alert(1)">나쁜 링크</a> <a href="//x.example/rel">상대 주소</a></td></tr></tbody></table><p>출처: 사내 위키</p><!--EndFragment--></body></html>`;
const WEB_TEXT = '지점 목록\n2026년\n지점\t주소\n강남\t지도\n문의 · 나쁜 링크 상대 주소\n출처: 사내 위키';

const HOSTILE_HTML = String.raw`<html><head><style>@import url(https://x.example/i.css);
@import "https://x.example/j.css";
.evil{background-image:url(https://x.example/bg.png);color:red;behavior:url(https://x.example/x.htc)}
.ok{background:url(https://x.example/b2.png) #00ff00}
td{background-image:url('https://x.example/td.png')}
.esc{background-image:\75 rl(https://x.example/esc.png)}</style>
<link rel="stylesheet" href="https://x.example/l.css"><meta http-equiv="refresh" content="0;url=https://x.example/"><base href="https://x.example/"></head>
<body><table background="https://x.example/a.png" style="background:url(https://x.example/t.png);width:expression(alert(1))"><tr><td class="evil" style="width:expression(alert(1));color:blue;-moz-binding:url(https://x.example/b.xml)">a</td><td class="ok esc" style="background-image:url(&quot;https://x.example/c.png&quot;)"><a href="javascript:alert(1)">b</a><a href=" JaVaScRiPt:alert(2)">c</a><svg onload="alert(1)"><image href="https://x.example/s.png"/></svg><img src="https://x.example/i.png" onerror="alert(1)"><iframe src="https://x.example/f"></iframe><object data="https://x.example/o"></object><input type="image" src="https://x.example/in.png"><video poster="https://x.example/p.png"></video><math><mi>x</mi></math><script>alert(3)</script></td></tr><tr><td style="color:red;background-color:expression(alert(1))">d</td><td style="border:1px solid url(https://x.example/q)">e</td></tr></table></body></html>`;

/** 큰 표 — rows × cols 칸 (엑셀 꼴로) */
function bigTable(rows, cols, cell = (r, c) => `${r}-${c}`) {
  const tr = [];
  for (let r = 0; r < rows; r++) {
    const td = [];
    for (let c = 0; c < cols; c++) td.push(`<td class=xl66>${cell(r, c)}</td>`);
    tr.push(`<tr>${td.join('')}</tr>`);
  }
  return `<html><head><style><!--.xl66{border:.5pt solid windowtext;}--></style></head><body><table>${tr.join('\r\n')}</table></body></html>`;
}

// ── 검토에서 나온 꼴 (tablefix.test.js) ──
// 엑셀 머리(<style> 의 class 규칙 — .xl66 은 .5pt 테두리)를 같이 쓰고 표만 바꾼다. .font6 은 칸 안 일부 글의 빨강·굵게
const XL_HEAD = EXCEL_HTML.slice(0, EXCEL_HTML.indexOf('<table'))
  .replace('.font5', '.font6\r\n\t{color:red;\r\n\tfont-weight:700;}\r\n.font5');
const xl = (table) => XL_HEAD + crlf(table) + '\r\n\r\n</body>\r\n\r\n</html>\r\n';

/** 숨긴 열 B 를 가로지르는 합친 칸(B1:D1, colspan=3) · 숨긴 3행을 가로지르는 합친 칸(A2:A4, rowspan=3). 엑셀은 숨긴 것까지 센다 */
const EXCEL_SPAN_HIDDEN_HTML = xl(`<table border=0 cellpadding=0 cellspacing=0 width=256 style='border-collapse:
 collapse;width:192pt'>
<!--StartFragment-->
 <col width=64 style='width:48pt'>
 <col width=0 style='display:none;mso-width-source:userset;mso-width-alt:0'>
 <col width=64 span=3 style='width:48pt'>
 <tr height=18 style='height:13.5pt'>
  <td height=18 class=xl66 width=64 style='height:13.5pt;width:48pt'>A1</td>
  <td colspan=3 class=xl66 width=64 style='border-left:none;width:48pt'>B1:D1</td>
  <td class=xl66 width=64 style='border-left:none;width:48pt'>E1</td>
 </tr>
 <tr height=18 style='height:13.5pt'>
  <td rowspan=3 height=36 class=xl66 style='height:27.0pt;border-top:none'>A2:A4</td>
  <td class=xl66 style='border-top:none;border-left:none;display:none'>B2</td>
  <td class=xl66 style='border-top:none;border-left:none'>C2</td>
  <td class=xl66 style='border-top:none;border-left:none'>D2</td>
  <td class=xl66 style='border-top:none;border-left:none'>E2</td>
 </tr>
 <tr height=0 style='display:none'>
  <td height=0 class=xl66 style='border-top:none;border-left:none'>B3</td>
  <td class=xl66 style='border-top:none;border-left:none'>C3</td>
  <td class=xl66 style='border-top:none;border-left:none'>D3</td>
  <td class=xl66 style='border-top:none;border-left:none'>E3</td>
 </tr>
 <tr height=18 style='height:13.5pt'>
  <td height=18 class=xl66 style='height:13.5pt;border-top:none;border-left:
  none;display:none'>B4</td>
  <td class=xl66 style='border-top:none;border-left:none'>C4</td>
  <td class=xl66 style='border-top:none;border-left:none'>D4</td>
  <td class=xl66 style='border-top:none;border-left:none'>E4</td>
 </tr>
 <tr height=18 style='height:13.5pt'>
  <td height=18 class=xl66 style='height:13.5pt;border-top:none'>A5</td>
  <td class=xl66 style='border-top:none;border-left:none;display:none'>B5</td>
  <td class=xl66 style='border-top:none;border-left:none'>C5</td>
  <td class=xl66 style='border-top:none;border-left:none'>D5</td>
  <td class=xl66 style='border-top:none;border-left:none'>E5</td>
 </tr>
<!--EndFragment-->
</table>`);
// 엑셀 글 몫 — 숨긴 행·열의 글도 실린다
const EXCEL_SPAN_HIDDEN_TEXT = 'A1\tB1:D1\t\t\tE1\r\nA2:A4\tB2\tC2\tD2\tE2\r\n\tB3\tC3\tD3\tE3\r\n\tB4\tC4\tD4\tE4\r\nA5\tB5\tC5\tD5\tE5\r\n';

/** 엑셀 칸 하나 (테두리 없음) — 숫자 하나를 문장 가운데에 붙이는 흔한 경우 */
const EXCEL_ONE_HTML = xl(`<table border=0 cellpadding=0 cellspacing=0 width=96 style='border-collapse:
 collapse;width:72pt'>
<!--StartFragment-->
 <col width=96 style='width:72pt'>
 <tr height=22 style='height:16.5pt'>
  <td height=22 align=right width=96 style='height:16.5pt;width:72pt'
  x:num="1234000">1,234,000</td>
 </tr>
<!--EndFragment-->
</table>`);
const EXCEL_ONE_TEXT = '1,234,000\r\n';
/** 엑셀 칸 하나지만 테두리를 그은 것 — 표로 둔다 */
const EXCEL_ONE_BORDER_HTML = EXCEL_ONE_HTML.replace('<td height=22 align=right', '<td height=22 class=xl66 align=right');
/** 엑셀 테두리 없는 칸 둘 (격자선만) */
const EXCEL_PLAIN_HTML = xl(`<table border=0 cellpadding=0 cellspacing=0 width=128 style='border-collapse:
 collapse;width:96pt'>
<!--StartFragment-->
 <col width=64 span=2 style='width:48pt'>
 <tr height=18 style='height:13.5pt'>
  <td height=18 width=64 style='height:13.5pt;width:48pt'>가</td>
  <td width=64 style='width:48pt'>나</td>
 </tr>
<!--EndFragment-->
</table>`);
/** 칸 안 일부 글만 빨강·굵게 (<font class="font6">) */
const EXCEL_FONT_HTML = xl(`<table border=0 cellpadding=0 cellspacing=0 width=128 style='border-collapse:
 collapse;width:96pt'>
<!--StartFragment-->
 <tr height=18 style='height:13.5pt'>
  <td height=18 class=xl66 style='height:13.5pt'>반품 <font class="font6">주의</font></td>
  <td class=xl66 style='border-left:none'>x</td>
 </tr>
<!--EndFragment-->
</table>`);

/** 워드 글머리 목록 — 기호는 Wingdings 글꼴의 글자(l·Ø·ü)로, 번호는 글로 실린다 (<span style='mso-list:Ignore'>) */
const wordItem = (font, glyph, text) => `<p class=MsoListParagraph style='margin-left:20.0pt;text-indent:-20.0pt;mso-list:l0 level1 lfo1'><![if !supportLists]><span
lang=EN-US style='font-family:${font};mso-fareast-font-family:${font}'><span style='mso-list:Ignore'>${glyph}<span
style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span></span><![endif]><span lang=KO>${text}<o:p></o:p></span></p>`;
const WORD_LIST_HTML = crlf(`<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta name=ProgId content=Word.Document><meta name=Generator content="Microsoft Word 15"></head>
<body lang=KO>
<!--StartFragment-->
${wordItem('Wingdings', 'Ø', '일정 확인')}
${wordItem('Wingdings', 'ü', '예산 확정')}
<p class=MsoListParagraph style='margin-left:20.0pt;text-indent:-20.0pt;mso-list:l1 level1 lfo2'><![if !supportLists]><span
lang=EN-US><span style='mso-list:Ignore'>1.<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>첫째</p>
<table class=MsoTableGrid border=1 cellspacing=0 cellpadding=0 style='border-collapse:collapse;border:none'>
 <tr>
  <td width=120 valign=top style='width:90pt;border:solid windowtext 1.0pt;padding:0cm 5.4pt 0cm 5.4pt'>
  ${wordItem('Wingdings', 'l', '견적서 보내기')}
  </td>
  <td width=120 valign=top style='width:90pt;border:solid windowtext 1.0pt;border-left:none;padding:0cm 5.4pt 0cm 5.4pt'>
  <p class=MsoNormal>김철수</p>
  </td>
 </tr>
</table>
<!--EndFragment-->
</body>
</html>`);

/** 리브레오피스 Calc — 글자색은 <font color>, 열 너비는 COL 없는 <colgroup width span> */
const CALC_HTML = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN">
<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"/><meta name="generator" content="LibreOffice 7.6.4.1 (Windows)"/>
<style type="text/css">body,div,table,thead,tbody,tfoot,tr,th,td,p { font-family:"Liberation Sans"; font-size:x-small }</style></head>
<body><table cellspacing="0" border="0">
	<colgroup width="120"></colgroup>
	<colgroup span="2" width="85"></colgroup>
	<tr>
		<td style="border: 1px solid #000000" height="17" align="left"><font color="#FF0000">사과</font></td>
		<td style="border: 1px solid #000000" align="right" sdval="12" sdnum="1042;"><font color="#FF0000">12</font></td>
		<td style="border: 1px solid #000000" align="right" sdval="0.4" sdnum="1042;0;0%">40%</td>
	</tr>
</table></body></html>`;

/** HTML 메일 한 열짜리 배치용 표 (테두리 없음) — 문단 둘을 골라 복사하면 표째로 실린다 */
const LAYOUT_MAIL_HTML = '<html><body>\r\n<!--StartFragment--><table width="600" cellpadding="0" cellspacing="0" border="0" style="color: rgb(34, 34, 34); font-family: Arial, Helvetica, sans-serif; font-size: small;"><tbody><tr><td style="padding: 24px 32px 8px; font-size: 15px; line-height: 24px; color: rgb(51, 51, 51);">안녕하세요, 주문하신 상품이 오늘 발송되었습니다.</td></tr><tr><td style="padding: 0px 32px 24px; font-size: 15px; line-height: 24px; color: rgb(51, 51, 51);">운송장 번호는 1234-5678-9012 입니다.</td></tr></tbody></table><!--EndFragment-->\r\n</body>\r\n</html>';
const LAYOUT_MAIL_TEXT = '안녕하세요, 주문하신 상품이 오늘 발송되었습니다.\n운송장 번호는 1234-5678-9012 입니다.';
/** 아웃룩 서명 — 두 칸짜리 border=0 표 */
const OUTLOOK_SIG_HTML = '<html><head><meta name=Generator content="Microsoft Word 15 (filtered medium)"></head><body lang=KO><!--StartFragment--><table class=MsoNormalTable border=0 cellspacing=0 cellpadding=0 style=\'border-collapse:collapse\'><tr><td width=80 valign=top style=\'width:60.0pt;padding:0cm 5.4pt 0cm 5.4pt\'><p class=MsoNormal><b><span style=\'font-size:10.0pt;color:#1F4E79\'>홍길동</span></b></p></td><td valign=top style=\'padding:0cm 5.4pt 0cm 5.4pt\'><p class=MsoNormal><span style=\'font-size:9.0pt;color:gray\'>영업팀 과장 | 010-0000-0000</span></p></td></tr></table><!--EndFragment--></body></html>';

module.exports = {
  EXCEL_HTML, EXCEL_TEXT, EXCEL_EMPTY_HTML, EXCEL_EMPTY_BORDER_HTML, SHEETS_HTML, SHEETS_TEXT,
  WORD_HTML, WORD_TEXT, HWP_HTML, HWP_TEXT, WEB_HTML, WEB_TEXT, HOSTILE_HTML, bigTable,
  EXCEL_SPAN_HIDDEN_HTML, EXCEL_SPAN_HIDDEN_TEXT, EXCEL_ONE_HTML, EXCEL_ONE_TEXT, EXCEL_ONE_BORDER_HTML, EXCEL_PLAIN_HTML, EXCEL_FONT_HTML,
  WORD_LIST_HTML, CALC_HTML, LAYOUT_MAIL_HTML, LAYOUT_MAIL_TEXT, OUTLOOK_SIG_HTML
};
