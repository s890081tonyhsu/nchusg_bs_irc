function toggleIntroduction(){
	$('#details').click(function(){
		$('#discription').toggle();
		$('#introduction').toggle();
	});
}

$(document).ready(toggleIntroduction());
