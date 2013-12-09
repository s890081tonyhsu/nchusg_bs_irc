function setDateButton(){
		if($("#datepicker").val().length==0){
			return;
		}else{
			var dateList = $("#datepicker").val().split("/");
		}
		var year  = dateList[2];
		var month = parseInt(dateList[0]);
		var day   = parseInt(dateList[1]);
		location.href = "http://" + location.host + location.pathname + "#" + year + "-" + month + "-" + day;
		location.reload();
}
