"use client";
import {useState} from 'react';
import SystemPicker from './system-picker';
import type {SystemInfo} from './navigation-types';
export default function MapSystemSearch({systems,onLocate,disabled=false}:{systems:SystemInfo[];onLocate:(system:SystemInfo)=>void;disabled?:boolean}){
  const [text,setText]=useState('');
  return <div className="nav-map-search" role="search" aria-label="星图定位"><span>星系定位</span><SystemPicker systems={systems} value={text} label="搜索星系并定位" placeholder="中文 / 拼音 / English" disabled={disabled} onChange={value=>setText(value)} onPick={onLocate}/></div>;
}
