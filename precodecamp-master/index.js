

let compare, max , max2

max = 0;
max2 = 0;

while(true){
    compare = prompt("add your number until click cancel \n will show your \n maximum number \n 2rd maximum number" )
    console.log(compare)
    if (+compare > max ){
      max = compare
    } else if (+compare <= max && +compare > max2){
      max2 = compare
    } else if(!compare){
      alert( `maximum number:${max} , second maximum number : ${max2} `);

      break;
    }
  }