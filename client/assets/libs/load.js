var jQueryScriptSourceURL='http://res.nchusg.org/js/jquery-1.10.2.min.js';
var bootstrapCSSSourceURL='http://res.nchusg.org/css/bootstrap.302.min.css';
var bootstrapJSSourceURL='http://res.nchusg.org/js/bootstrap.302.min.js';
var navbarHTMLSourceURL='http://res.nchusg.org/nav/nav.html';

// jQueryScriptSourceURL='res/js/jquery-1.10.2.min.js';
// bootstrapCSSSourceURL='res/css/bootstrap.302.min.css';
// bootstrapJSSourceURL='res/js/bootstrap.302.min.js';
// navbarHTMLSourceURL='nav.html';

function jQueryOK(){
	if($('link[href*=bootstrap]').is('link[rel=stylesheet]'))
		console.log("bootstrap OK!");
	else{
		console.log("no bootstrap detacted, starting to add...");
		var bootstrapCSS=$('<link href="'+bootstrapCSSSourceURL+'" rel="stylesheet">');
		bootstrapCSS.ready(function(){
			console.log('bootstrapCSS ready!');
		});
		$("head").append(bootstrapCSS);
		
		var bootstrapJS=$('<script type="text/javascript" src="'+bootstrapJSSourceURL+'"></script>');
		bootstrapJS.ready(function(){
			console.log('bootstrapJS ready!');
		});
		$("head").append(bootstrapJS);

		console.log('start to load navbarHTML...');
		$.ajax({
			url:navbarHTMLSourceURL,
			success:function(data){
				$('body').prepend(data);
				$('body').css('padding-top','60px');
				console.log('navbarHTML OK!');
			}
		});
	}
}

if (((typeof jQuery)==='undefined')||((typeof $)==='undefined')||((typeof jquery)==='undefined')) {
	var jQueryScript=document.createElement('script');
	jQueryScript.setAttribute('src',jQueryScriptSourceURL);
	if(document.getElementsByTagName('head').item(0)==null)
		document.getElementsByTagName('html').item(0).appendChild(document.createElement('head'));
	jQueryScript=document.getElementsByTagName('head').item(0).appendChild(jQueryScript);


	var	jQueryScriptLoadCompleted=jQueryOK;
	jQueryScript.onload=function(jQueryScriptLoadEvent){
		try{
			//console.log('Self test ...$("head").html()=\n'+$("head").html());
			if(((typeof $)==='function')){
				console.log("jQueryScript loaded!");
				jQueryScriptLoadCompleted();
			}
			else{
				console.log("lack $ for jquery!");
			}
		}catch(exception){
			console.log('Fatal Error:'+exception.message);
			if(!jQueryScriptLoadEvent.returnValue)
				console.log('Loading jQueryScript was failed!');
		}
	};
}
else{
	jQueryOK();
}


