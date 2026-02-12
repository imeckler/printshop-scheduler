/** @jsx jsx */
/** @jsxFrag Fragment */
import { jsx, Fragment } from 'hono/jsx/dom';
import { render } from 'hono/jsx/dom';
import { isSuccessResponse } from './apiClient';
import moment from 'moment-timezone';
import { BookCustomRangeRequest, BookingDensityResponse,
  BookingDensityRequest } from '../lib/apiTypes';


interface Unit {
  unitId: number;
  name: string;
  capacity: number;
  active: boolean;
}

interface TimeSlot {
  time: Date;
  label: string;
  bookedCount: number;
  totalCapacity: number;
}

class BookingManager {
  private dateInput: HTMLInputElement;
  private unitSelect: HTMLSelectElement;
  private calendarContainer: HTMLElement;
  private dayCalendar: HTMLElement;
  private loadingDiv: HTMLElement;
  private selectedRangeDisplay: HTMLElement;
  private confirmButton: HTMLButtonElement;
  private clearButton: HTMLButtonElement;
  
  private units: Unit[] = [];
  private timeSlots: TimeSlot[] = [];
  private selectedStartIndex: number | null = null;
  private selectedEndIndex: number | null = null;
  private isDragging: boolean = false;

  constructor() {
    this.dateInput = document.getElementById('bookingDate') as HTMLInputElement;
    this.unitSelect = document.getElementById('unitSelect') as HTMLSelectElement;
    this.calendarContainer = document.getElementById('calendar-container') as HTMLElement;
    this.dayCalendar = document.getElementById('day-calendar') as HTMLElement;
    this.loadingDiv = document.getElementById('loading') as HTMLElement;
    this.selectedRangeDisplay = document.getElementById('selected-range-display') as HTMLElement;
    this.confirmButton = document.getElementById('confirm-booking') as HTMLButtonElement;
    this.clearButton = document.getElementById('clear-selection') as HTMLButtonElement;

    // Set today's date as default in LA timezone
    const todayLA = moment.tz('America/Los_Angeles');
    this.dateInput.value = todayLA.format('YYYY-MM-DD');

    this.setupEventListeners();
    this.loadUnits();
  }

  private setupEventListeners(): void {
    this.dateInput.addEventListener('change', this.loadCalendar.bind(this));
    this.unitSelect.addEventListener('change', this.loadCalendar.bind(this));
    this.confirmButton.addEventListener('click', this.confirmBooking.bind(this));
    this.clearButton.addEventListener('click', this.clearSelection.bind(this));
  }

  private async loadUnits(): Promise<void> {
    try {
      const response = await fetch('/api/units');
      if (response.ok) {
        const result = await response.json();
        this.units = result.data || [];
        this.populateUnitOptions();
        if (this.units.length > 0) {
          this.loadCalendar();
        }
      }
    } catch (error) {
      console.error('Error loading units:', error);
    }
  }

  private populateUnitOptions(): void {
    this.unitSelect.innerHTML = '';
    this.units.forEach(unit => {
      const option = <option value={unit.unitId.toString()}>{unit.name} (Capacity: {unit.capacity})</option>;
      const tempContainer = document.createElement('div');
      render(option, tempContainer);
      if (tempContainer.firstElementChild) {
        this.unitSelect.appendChild(tempContainer.firstElementChild);
      }
    });
  }

  private getSelectedUnit(): Unit | null {
    const selectedUnitId = parseInt(this.unitSelect.value);
    return this.units.find(u => u.unitId === selectedUnitId) || null;
  }

  private getDayRange(): { start: Date; end: Date } {
    const selectedDateStr = this.dateInput.value;
    const selectedDateLA = moment.tz(selectedDateStr, 'America/Los_Angeles');
    
    const startDateLA = selectedDateLA.clone().hour(0).minute(0).second(0); // Start at 6 AM
    const endDateLA = selectedDateLA.clone().hour(23).minute(0).second(0);   // End at 11 PM

    return { 
      start: startDateLA.utc().toDate(), 
      end: endDateLA.utc().toDate() 
    };
  }

  private async loadCalendar(): Promise<void> {
    const selectedUnit = this.getSelectedUnit();
    if (!selectedUnit) return;

    this.showLoading(true);
    this.clearSelection();

    const { start, end } = this.getDayRange();

    try {
      const response = await fetch(`/api/booking-density?unitId=${selectedUnit.unitId}&start=${start.toISOString()}&end=${end.toISOString()}`);
      
      if (response.ok) {
        const densityData: BookingDensityResponse = await response.json();
        this.generateTimeSlots(densityData, selectedUnit);
        this.renderCalendar();
        this.calendarContainer.style.display = 'block';
      } else {
        this.showError('Failed to load calendar data');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        window.location.href = '/login';
        return;
      }
      this.showError('Network error. Please try again.');
    } finally {
      this.showLoading(false);
    }
  }

  private generateTimeSlots(densityData: BookingDensityResponse, unit: Unit): void {
    this.timeSlots = [];
    // const { start, end } = this.getDayRange();

    const selectedDateStr = this.dateInput.value;
    const selectedDateLA = moment.tz(selectedDateStr, 'America/Los_Angeles');
    const start = selectedDateLA.clone().hour(0).minute(0).second(0); // Start at 6 AM
    const end = selectedDateLA.clone().hour(23).minute(59).second(0); // Start at 6 AM

    // Generate 15-minute time slots
    // const endMoment = moment.tz(end, 'America/Los_Angeles');
    const current = start.clone();
    while (current.isBefore(end)) {
      const slotStart = current.clone();
      const slotEnd = slotStart.clone().add(15, 'minutes');

      const startDate = slotStart.toDate();
      const endDate = slotEnd.toDate();
      // [       ]
      //      [        ]
      // const bookedCount = densityData.intervals.find((x) => endDate >= new Date(x.startTime))?.bookedCount || 0;

      this.timeSlots.push({
        time: slotStart.toDate(),
        label: slotStart.format('h:mm A'),
        bookedCount: 0,
        totalCapacity: unit.capacity,
      });

      current.add(15, 'minutes');
    }
    const startEpoch = start.toDate().getTime();
    densityData.intervals.forEach((x) => {
      const FIFTEEN_MINUTES = 15 * 60 * 1000;
      const startIndex = Math.floor(((new Date(x.startTime)).getTime() - startEpoch) / FIFTEEN_MINUTES);
      const endIndex = Math.ceil(((new Date(x.endTime)).getTime() - startEpoch) / FIFTEEN_MINUTES);
      for (let i = startIndex; i < Math.min(endIndex + 1, this.timeSlots.length); ++i) {
        this.timeSlots[i].bookedCount = x.bookedCount;
      }
    });
    
    /*
    while (current.isBefore(endMoment)) {
      const slotStart = current.clone();
      const slotEnd = current.clone().add(15, 'minutes');
      
      // Find the booking density for this time slot
      let bookedCount = 0;
      for (const interval of densityData.intervals) {
        const intervalStart = moment.utc(interval.startTime);
        const intervalEnd = moment.utc(interval.endTime);
        
        // Check if our 15-minute slot overlaps with this density interval
        if (slotStart.utc().isBefore(intervalEnd) && slotEnd.utc().isAfter(intervalStart)) {
          bookedCount = interval.bookedCount;
          break;
        }
      }
      
      this.timeSlots.push({
        time: slotStart.toDate(),
        label: slotStart.format('h:mm A'),
        bookedCount,
        totalCapacity: unit.capacity
      });
      
      current.add(15, 'minutes');
    }
    */
  }

  private renderCalendar(): void {
    this.dayCalendar.innerHTML = '';
    
    this.timeSlots.forEach((slot, index) => {
      const timeSlotElement = this.createTimeSlotElement(slot, index);
      this.dayCalendar.appendChild(timeSlotElement);
    });
  }
  
  private createTimeSlotElement(slot: TimeSlot, index: number): HTMLElement {
    const slotElement = document.createElement('div');
    slotElement.className = 'time-slot';
    slotElement.dataset.index = index.toString();
    
    // Time label
    const timeLabel = document.createElement('div');
    timeLabel.className = 'time-label';
    timeLabel.textContent = slot.label;
    
    // Density bar
    const densityBar = document.createElement('div');
    densityBar.className = 'density-bar';
    
    const densityIndicator = document.createElement('div');
    densityIndicator.className = 'density-indicator';
    
    const utilizationPercent = slot.totalCapacity > 0 ? Math.round((slot.bookedCount / slot.totalCapacity) * 100) : 0;
    let densityClass = 'density-0';
    if (utilizationPercent >= 75) densityClass = 'density-100';
    else if (utilizationPercent >= 50) densityClass = 'density-75';
    else if (utilizationPercent >= 25) densityClass = 'density-50';
    else if (utilizationPercent > 0) densityClass = 'density-25';
    
    densityIndicator.classList.add(densityClass);
    densityIndicator.style.width = `${Math.max(utilizationPercent, 10)}%`;
    
    const densityText = document.createElement('span');
    densityText.className = 'density-text';
    densityText.textContent = `${slot.bookedCount}/${slot.totalCapacity} booked`;
    
    densityBar.appendChild(densityIndicator);
    densityBar.appendChild(densityText);
    
    slotElement.appendChild(timeLabel);
    slotElement.appendChild(densityBar);
    
    // Add event listeners for drag selection
    slotElement.addEventListener('mousedown', (e) => this.startSelection(e, index));
    slotElement.addEventListener('mouseenter', (e) => this.updateSelection(e, index));
    slotElement.addEventListener('mouseup', (e) => this.endSelection(e, index));

    // Add touch event listeners for mobile support
    slotElement.addEventListener('touchstart', (e) => {
      e.preventDefault(); // Prevent scrolling
      this.startSelection(e, index);
    }, { passive: false });
    slotElement.addEventListener('touchmove', (e) => {
      e.preventDefault(); // Prevent scrolling
      // Find which slot the touch is over
      const touch = e.touches[0];
      const element = document.elementFromPoint(touch.clientX, touch.clientY);
      const slotElement = element?.closest('.time-slot') as HTMLElement;
      if (slotElement?.dataset.index) {
        const touchIndex = parseInt(slotElement.dataset.index);
        this.updateSelection(e, touchIndex);
      }
    }, { passive: false });
    slotElement.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.endSelection(e, index);
    }, { passive: false });
    
    return slotElement;
  }

  private startSelection(event: MouseEvent | TouchEvent, index: number): void {
    event.preventDefault();
    this.isDragging = true;
    this.selectedStartIndex = index;
    this.selectedEndIndex = index;
    this.updateSelectionDisplay();
    
    // Add global mouse/touch end listeners
    document.addEventListener('mouseup', this.globalMouseUp.bind(this), { once: true });
    document.addEventListener('touchend', this.globalMouseUp.bind(this), { once: true });
  }
  
  private updateSelection(event: MouseEvent | TouchEvent, index: number): void {
    if (!this.isDragging || this.selectedStartIndex === null) return;
    
    this.selectedEndIndex = index;
    this.updateSelectionDisplay();
  }
  
  private endSelection(event: MouseEvent | TouchEvent, index: number): void {
    if (!this.isDragging) return;
    this.isDragging = false;
  }
  
  private globalMouseUp(): void {
    this.isDragging = false;
  }

  private updateSelectionDisplay(): void {
    // Clear all selection classes
    this.dayCalendar.querySelectorAll('.time-slot').forEach(slot => {
      slot.classList.remove('selected', 'selecting');
    });
    
    if (this.selectedStartIndex === null || this.selectedEndIndex === null) {
      this.selectedRangeDisplay.textContent = '';
      this.confirmButton.disabled = true;
      return;
    }
    
    const startIndex = Math.min(this.selectedStartIndex, this.selectedEndIndex);
    const endIndex = Math.max(this.selectedStartIndex, this.selectedEndIndex);
    
    // Highlight selected range
    for (let i = startIndex; i <= endIndex; i++) {
      const slotElement = this.dayCalendar.querySelector(`[data-index="${i}"]`);
      if (slotElement) {
        slotElement.classList.add(this.isDragging ? 'selecting' : 'selected');
      }
    }
    
    // Update display text
    const startTime = this.timeSlots[startIndex];
    const endTime = this.timeSlots[endIndex];
    if (startTime && endTime) {
      const startLabel = startTime.label;
      const endMoment = moment(endTime.time).add(15, 'minutes');
      const endLabel = endMoment.format('h:mm A');
      this.selectedRangeDisplay.textContent = `Selected: ${startLabel} - ${endLabel}`;
      this.confirmButton.disabled = false;
    }
  }

  private clearSelection(): void {
    this.selectedStartIndex = null;
    this.selectedEndIndex = null;
    this.isDragging = false;
    this.updateSelectionDisplay();
  }
  
  private async confirmBooking(): Promise<void> {
    if (this.selectedStartIndex === null || this.selectedEndIndex === null) return;
    
    const selectedUnit = this.getSelectedUnit();
    if (!selectedUnit) return;
    
    const startIndex = Math.min(this.selectedStartIndex, this.selectedEndIndex);
    const endIndex = Math.max(this.selectedStartIndex, this.selectedEndIndex);
    
    const startTime = this.timeSlots[startIndex].time;
    const endTime = moment(this.timeSlots[endIndex].time).add(15, 'minutes').toDate();
    
    try {
      const response = await fetch('/api/book-custom-range', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          unitId: selectedUnit.unitId,
          start: startTime.toISOString(),
          end: endTime.toISOString()
        })
      });
      
      if (response.ok) {
        alert('Booking successful! Redirecting to home page...');
        window.location.href = '/';
      } else if (response.status === 402) {
        const result = await response.json();
        const errorMsg = result.error || 'Insufficient credits';
        if (confirm(errorMsg + '\n\nWould you like to add credits now?')) {
          window.location.href = '/credits';
        }
      } else {
        const result = await response.json();
        alert('Booking failed: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        window.location.href = '/login';
        return;
      }
      alert('Network error. Please try again.');
    }
  }

  private showLoading(show: boolean): void {
    this.loadingDiv.style.display = show ? 'block' : 'none';
    this.calendarContainer.style.display = show ? 'none' : 'block';
  }

  private showError(message: string): void {
    this.calendarContainer.innerHTML = '';
    const errorMsg = <p style="color: red;">Error: {message}</p>;
    render(errorMsg, this.calendarContainer);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new BookingManager();
});
