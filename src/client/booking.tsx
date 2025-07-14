/** @jsx jsx */
/** @jsxFrag Fragment */
import { jsx, Fragment } from 'hono/jsx/dom';
import { render } from 'hono/jsx/dom';
import { getAvailableSlots, bookSlot, isSuccessResponse } from './apiClient';
import { AvailableSlot } from '../lib/apiTypes';
import * as moment from 'moment-timezone';

interface TimeSlotOption {
  timeRange: string;
  slot: AvailableSlot;
  availableCount: number;
}

class BookingManager {
  private dateInput: HTMLInputElement;
  private timeSelect: HTMLSelectElement;
  private slotsContainer: HTMLElement;
  private loadingDiv: HTMLElement;
  private userBookings: any[] = [];

  constructor() {
    this.dateInput = document.getElementById('bookingDate') as HTMLInputElement;
    this.timeSelect = document.getElementById('timeSelect') as HTMLSelectElement;
    this.slotsContainer = document.getElementById('slotsContainer') as HTMLElement;
    this.loadingDiv = document.getElementById('loading') as HTMLElement;

    // Set today's date as default in LA timezone
    const todayLA = moment.tz('America/Los_Angeles');
    this.dateInput.value = todayLA.format('YYYY-MM-DD');

    this.setupEventListeners();
    this.populateTimeOptions();
    this.loadAvailableSlots();
  }

  private setupEventListeners(): void {
    this.dateInput.addEventListener('change', this.loadAvailableSlots.bind(this));
    this.timeSelect.addEventListener('change', this.loadAvailableSlots.bind(this));
  }

  private populateTimeOptions(): void {
    const allDayOption = <option value="all-day">All day</option>;
    render(allDayOption, this.timeSelect);

    for (let hour = 6; hour <= 22; hour++) {
      for (let minute = 0; minute < 60; minute += 30) {
        const timeString = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        const displayTime = new Date(`2000-01-01T${timeString}`).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });

        const option = <option value={timeString}>{displayTime}</option>;
        const tempContainer = document.createElement('div');
        render(option, tempContainer);
        if (tempContainer.firstElementChild) {
          this.timeSelect.appendChild(tempContainer.firstElementChild);
        }
      }
    }
  }

  private getTimeRange(): { start: Date; end: Date } {
    const selectedDateStr = this.dateInput.value;
    const selectedTime = this.timeSelect.value;
    const nowLA = moment.tz('America/Los_Angeles');
    const todayLA = nowLA.clone().startOf('day');
    const selectedDateLA = moment.tz(selectedDateStr, 'America/Los_Angeles');

    if (selectedTime === 'all-day') {
      let startDateLA = selectedDateLA.clone().startOf('day');
      
      // If selected date is today, start from current LA time, otherwise start from midnight
      if (selectedDateLA.isSame(todayLA, 'day')) {
        startDateLA = nowLA.clone();
      }

      const endDateLA = selectedDateLA.clone().endOf('day');

      // Convert LA times to UTC for server
      return { 
        start: startDateLA.utc().toDate(), 
        end: endDateLA.utc().toDate() 
      };
    } else {
      const [hour, minute] = selectedTime.split(':').map(Number);

      const startDateLA = selectedDateLA.clone().hour(hour - 1).minute(minute).second(0);
      const endDateLA = selectedDateLA.clone().hour(hour + 2).minute(minute).second(0);

      // If selected date is today and the start time is in the past, start from now
      if (selectedDateLA.isSame(todayLA, 'day') && startDateLA.isBefore(nowLA)) {
        startDateLA.set(nowLA.toObject());
      }

      // Convert LA times to UTC for server
      return { 
        start: startDateLA.utc().toDate(), 
        end: endDateLA.utc().toDate() 
      };
    }
  }

  private async loadAvailableSlots(): Promise<void> {
    this.showLoading(true);

    const { start, end } = this.getTimeRange();
    console.log(start, end);

    try {
      // Load available slots and user bookings in parallel
      const [slotsResult, bookingsResult] = await Promise.all([
        getAvailableSlots({
          start: start.toISOString(),
          stop: end.toISOString(),
        }),
        this.loadUserBookingsInRange(start, end)
      ]);

      if (isSuccessResponse(slotsResult)) {
        this.renderTimeSlots(slotsResult.data);
      } else {
        this.showError(slotsResult.error);
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

  private async loadUserBookingsInRange(start: Date, end: Date): Promise<void> {
    try {
      const response = await fetch(`/user-bookings-in-range?start=${start.toISOString()}&stop=${end.toISOString()}`);
      if (response.ok) {
        const result = await response.json();
        this.userBookings = result.data || [];
      } else {
        this.userBookings = [];
      }
    } catch (error) {
      console.error('Error loading user bookings:', error);
      this.userBookings = [];
    }
  }

  private hasBookingConflict(slot: AvailableSlot): boolean {
    const slotStart = moment.utc(slot.slot.start);
    const slotEnd = moment.utc(slot.slot.end);

    return this.userBookings.some(booking => {
      if (booking.status !== 'confirmed') return false;
      
      // Parse booking slot range like "[2025-01-01 10:00:00+00,2025-01-01 10:30:00+00)"
      const match = booking.slot.match(/\[([^,]+),([^)]+)\)/);
      if (!match) return false;
      
      const bookingStart = moment.utc(match[1]);
      const bookingEnd = moment.utc(match[2]);
      
      // Check if slots overlap
      return slotStart.isBefore(bookingEnd) && slotEnd.isAfter(bookingStart);
    });
  }

  private renderTimeSlots(slots: AvailableSlot[]): void {
    this.slotsContainer.innerHTML = '';

    if (slots.length === 0) {
      const noSlotsMsg = <p>No available slots for the selected time range.</p>;
      render(noSlotsMsg, this.slotsContainer);
      return;
    }

    const timeSlotOptions = this.processTimeSlots(slots);

    const flexContainer = (
      <div className="time-slots-flex">
        {timeSlotOptions.map(timeSlotOption => this.TimeSlotCard({ timeSlotOption }))}
      </div>
    );

    render(flexContainer, this.slotsContainer);
  }

  private TimeSlotCard({ timeSlotOption }: { timeSlotOption: TimeSlotOption }) {
    const hasConflict = this.hasBookingConflict(timeSlotOption.slot);
    const cardClass = hasConflict ? "time-slot-card conflicted" : "time-slot-card";
    
    return (
      <div 
        className={cardClass} 
        onClick={hasConflict ? undefined : () => this.bookSlot(timeSlotOption.slot)}
        style={hasConflict ? { cursor: 'not-allowed' } : undefined}
      >
        <div className="time-slot-time">{timeSlotOption.timeRange}</div>
        <div className="time-slot-price">${(timeSlotOption.slot.price / 100).toFixed(2)}</div>
        <div className="time-slot-availability">
          {hasConflict ? 
            "Already booked" : 
            `${timeSlotOption.availableCount} unit${timeSlotOption.availableCount !== 1 ? 's' : ''} available`
          }
        </div>
      </div>
    );
  }

  private processTimeSlots(slots: AvailableSlot[]): TimeSlotOption[] {
    const slotsByTime = new Map<string, AvailableSlot[]>();

    slots.forEach(slot => {
      const timeKey = this.formatTime(slot.slot.start) + ' - ' + this.formatTime(slot.slot.end);
      if (!slotsByTime.has(timeKey)) {
        slotsByTime.set(timeKey, []);
      }
      slotsByTime.get(timeKey)!.push(slot);
    });

    const timeSlotOptions: TimeSlotOption[] = [];

    slotsByTime.forEach((unitsForTime, timeRange) => {
      unitsForTime.sort((a, b) => a.unitId - b.unitId);
      const selectedSlot = unitsForTime[0];

      timeSlotOptions.push({
        timeRange,
        slot: selectedSlot,
        availableCount: unitsForTime.length,
      });
    });

    timeSlotOptions.sort(
      (a, b) => new Date(a.slot.slot.start).getTime() - new Date(b.slot.slot.start).getTime()
    );

    return timeSlotOptions;
  }

  public async bookSlot(slot: AvailableSlot): Promise<void> {
    if (!confirm(`Book this slot for $${(slot.price / 100).toFixed(2)}?`)) {
      return;
    }

    try {
      const result = await bookSlot(slot);

      if (isSuccessResponse(result)) {
        alert('Booking successful! Redirecting to home page...');
        window.location.href = '/';
      } else {
        alert('Booking failed: ' + result.error);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        window.location.href = '/login';
        return;
      }
      alert('Network error. Please try again.');
    }
  }

  private formatTime(isoString: string): string {
    return moment.utc(isoString).tz('America/Los_Angeles').format('h:mm A');
  }

  private showLoading(show: boolean): void {
    this.loadingDiv.style.display = show ? 'block' : 'none';
    this.slotsContainer.style.display = show ? 'none' : 'block';
  }

  private showError(message: string): void {
    this.slotsContainer.innerHTML = '';
    const errorMsg = <p style="color: red;">Error: {message}</p>;
    render(errorMsg, this.slotsContainer);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new BookingManager();
});
