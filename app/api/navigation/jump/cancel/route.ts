import {DELETE as cancelCalculation} from '../auto/route';
export async function DELETE(request:Request){return cancelCalculation(request);}
