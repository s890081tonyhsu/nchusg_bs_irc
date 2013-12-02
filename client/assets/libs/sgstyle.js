function toggleIntroduction(){
	$('#details').click(function(){
		$('#description').toggle();
		$('#introduction').toggle();
	});
}

$(document).ready(toggleIntroduction);
